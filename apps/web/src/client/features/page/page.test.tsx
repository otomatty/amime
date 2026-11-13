import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "./page.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** テストで開くページのID。 */
const PAGE_ID = "p1";
const BY_TITLE = "/api/projects/team/pages/by-title/";

/**
 * fetch を差し替える。名前からページを引く要求には、決まったIDと、URLの名前から作った名前を返す。
 * それ以外の要求(ページの読み込みと、コミット)を handler に渡す。返すのは、handler の呼び出しの記録。
 */
const NO_LINKS = { missing: [], related: [], hops: [] };

function stubFetch(
	handler: Handler,
	info: {
		title?: string;
		problem?: string | null;
		pinned?: boolean;
		/** ページのつながりへの応答。省くと、つながりのないページ。 */
		links?: () => Response;
		/** 名前で探したときに返す名前。省くと、何も見つからない。 */
		titles?: readonly string[];
	} = {},
) {
	const fetchMock = vi.fn(handler);
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		// ページのつながりにも、ここで答える。
		if (url.endsWith("/links")) return info.links?.() ?? json(NO_LINKS);
		if (url.startsWith("/api/projects/team/pages/titles"))
			return json({ titles: info.titles ?? [] });
		if (!url.startsWith(BY_TITLE)) return fetchMock(url, init);
		const name = decodeURIComponent(url.slice(BY_TITLE.length));
		const title = info.title ?? name.replaceAll("_", " ");
		return json({
			id: PAGE_ID,
			title,
			problem: info.problem ?? null,
			pinned: info.pinned ?? false,
		});
	});
	return fetchMock;
}

const lines = () => screen.getAllByTestId("line").map((line) => line.getAttribute("data-text"));
const status = () => screen.getByRole("status").textContent;
const type = (text: string) =>
	fireEvent.input(screen.getByLabelText("ページの本文"), { target: { value: text } });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
});

/** 以前のタブが端末内に残した、未送信の変更。 */
function leavePending(changes: unknown[]) {
	window.localStorage.setItem(
		`amime:pending:${PAGE_ID}:closed-tab`,
		JSON.stringify({ savedAt: Date.now(), entries: [{ inflight: null, changes }] }),
	);
}
/** 端末内に残っている、未送信の変更(送信中のコミットの中身も含む)。 */
const pendingRecords = () =>
	Object.values({ ...window.localStorage }).map((value) =>
		JSON.parse(String(value)).entries.flatMap(
			(entry: { inflight: { changes: unknown[] } | null; changes: unknown[] }) => [
				...(entry.inflight?.changes ?? []),
				...entry.changes,
			],
		),
	);

const SAVED = { version: 1, lines: [{ id: "a", text: "買い物" }] };

/** WebSocket の代わりを置いて、ページを開く。届けるメッセージと、送られたメッセージを扱える。 */
async function openWithSocket(info: Parameters<typeof stubFetch>[1] = {}) {
	const sockets: (EventTarget & { sent: string[] })[] = [];
	class CapturedSocket extends EventTarget {
		static readonly OPEN = 1;
		readonly readyState = 1;
		readonly sent: string[] = [];
		constructor() {
			super();
			sockets.push(this);
		}
		send(data: string) {
			this.sent.push(data);
		}
		close() {}
	}
	vi.stubGlobal("WebSocket", CapturedSocket);
	stubFetch(() => json(SAVED), info);
	render(<Page name="買い物" />);
	await waitFor(() => expect(lines()).toEqual(["買い物"]));
	await waitFor(() => expect(sockets).toHaveLength(1));
	const socket = sockets[0];
	if (!socket) throw new Error("no socket");
	const receive = (message: unknown) =>
		act(() => {
			const data = typeof message === "string" ? message : JSON.stringify(message);
			socket.dispatchEvent(new MessageEvent("message", { data }));
		});
	return { socket, receive };
}

describe("Page", () => {
	const saved = SAVED;

	it("読み込んでいるあいだは、そのことを表示する", () => {
		stubFetch(() => new Promise(() => {}));

		render(<Page name="買い物" />);

		expect(status()).toBe("読み込んでいます…");
	});

	it("保存されているページを読み込んで表示する", async () => {
		stubFetch(() => json(saved));

		render(<Page name="買い物" />);

		await waitFor(() => expect(lines()).toEqual(["買い物"]));
		expect(status()).toBe("保存済み");
	});

	it("まだないページは、URLの名前をタイトルにして始める。書くまでは保存しない", async () => {
		const fetchMock = stubFetch(() => json({ version: 0, lines: [] }));

		render(<Page name="新しい_ページ" />);

		await waitFor(() => expect(lines()).toEqual(["新しい ページ"]));
		expect(status()).toBe("新しいページです。書き始めると保存されます");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("書くと未保存になり、しばらくすると保存されて、保存済みになる", async () => {
		const fetchMock = stubFetch((_url, init) => {
			if (init?.method !== "POST") return json(saved);
			const { changes } = JSON.parse(String(init.body));
			return json({ version: 2, applied: changes });
		});
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));

		fireEvent.mouseDown(screen.getByTestId("line"));
		type("牛乳");

		expect(status()).toBe("未保存の変更があります");
		await waitFor(() => expect(status()).toBe("保存済み"));
		const commit = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
		expect(JSON.parse(String(commit?.[1]?.body))).toMatchObject({
			changes: [{ type: "update", id: "a", text: "買い物牛乳" }],
		});
	});

	it("他の人の変更が先に入っていたら、読み直して画面に取り込む", async () => {
		const latest = {
			version: 3,
			lines: [
				{ id: "a", text: "買い物牛乳" },
				{ id: "x", text: "他の人の行" },
			],
		};
		let commits = 0;
		stubFetch((_url, init) => {
			if (init?.method !== "POST") return json(commits === 0 ? saved : latest);
			commits += 1;
			const { changes } = JSON.parse(String(init.body));
			// 他の人のコミットが先に入っていたので、バージョンが2つ進んでいる。
			return json({ version: 3, applied: changes });
		});
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));

		fireEvent.mouseDown(screen.getByTestId("line"));
		type("牛乳");

		await waitFor(() => expect(lines()).toEqual(["買い物牛乳", "他の人の行"]));
		await waitFor(() => expect(status()).toBe("保存済み"));
	});

	it("まだないページで、打った文字を取り消して最初の内容に戻したら、保存しない", async () => {
		const fetchMock = stubFetch(() => json({ version: 0, lines: [] }));
		render(<Page name="メモ" />);
		await waitFor(() => expect(lines()).toEqual(["メモ"]));

		fireEvent.mouseDown(screen.getByTestId("line"));
		type("a");
		expect(status()).toBe("未保存の変更があります");
		fireEvent.keyDown(screen.getByLabelText("ページの本文"), { key: "z", ctrlKey: true });

		expect(lines()).toEqual(["メモ"]);
		expect(status()).toBe("新しいページです。書き始めると保存されます");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("サーバーに内容を断られたら、直し方を伝える", async () => {
		stubFetch((_url, init) => (init?.method === "POST" ? json({}, 400) : json(saved)));
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));

		fireEvent.mouseDown(screen.getByTestId("line"));
		type("牛乳");

		await waitFor(() => expect(status()).toMatch(/保存できない内容があります/));
	});

	describe("未送信の変更", () => {
		const echo = (_url: string, init?: RequestInit) => {
			if (init?.method !== "POST") return json(saved);
			return json({ version: 2, applied: JSON.parse(String(init.body)).changes });
		};

		it("書いた内容は、保存が終わるまで端末内に残し、保存が終わったら消す", async () => {
			let respond = () => {};
			stubFetch((url, init) => {
				if (init?.method !== "POST") return json(saved);
				return new Promise((resolve) => {
					respond = () => resolve(echo(url, init));
				});
			});
			render(<Page name="買い物" />);
			await waitFor(() => expect(lines()).toEqual(["買い物"]));

			fireEvent.mouseDown(screen.getByTestId("line"));
			type("牛乳");

			expect(pendingRecords()).toEqual([
				[{ type: "update", id: "a", text: "買い物牛乳", base: "買い物" }],
			]);
			await waitFor(() => expect(status()).toBe("保存しています…"));
			respond();
			await waitFor(() => expect(status()).toBe("保存済み"));
			expect(pendingRecords()).toEqual([]);
		});

		it("前回送れなかった変更が残っていたら、復元して表示し、そのまま保存する", async () => {
			leavePending([{ type: "update", id: "a", text: "買い物 前回の入力" }]);
			const fetchMock = stubFetch(echo);

			render(<Page name="買い物" />);

			await waitFor(() => expect(lines()).toEqual(["買い物 前回の入力"]));
			expect(screen.getByRole("note").textContent).toMatch(
				/前回、送信できなかった変更を復元しました/,
			);
			// 復元した変更を送るまでのあいだも、表示は「保存済み」になることがある。送ったことを先に確かめる。
			const sent = () => fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
			await waitFor(() => expect(sent()).toBeDefined());
			await waitFor(() => expect(status()).toBe("保存済み"));
			expect(JSON.parse(String(sent()?.[1]?.body))).toMatchObject({
				changes: [{ type: "update", id: "a", text: "買い物 前回の入力" }],
			});
			expect(pendingRecords()).toEqual([]);
		});

		it("まだ保存されていないページに書いた内容も、復元して保存する", async () => {
			const title = {
				type: "insert",
				line: { id: "t", text: "前回書いた題" },
				after: null,
				before: null,
			};
			leavePending([title]);
			const fetchMock = stubFetch((_url, init) =>
				init?.method === "POST"
					? json({ version: 1, applied: [title] })
					: json({ version: 0, lines: [] }),
			);

			render(<Page name="新しいページ" />);

			await waitFor(() => expect(lines()).toEqual(["前回書いた題"]));
			await waitFor(() => expect(status()).toBe("保存済み"));
			expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
		});

		it("復元するものがなければ、復元の案内は出さない", async () => {
			stubFetch(echo);

			render(<Page name="買い物" />);

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			expect(screen.queryByRole("note")).toBeNull();
		});
	});

	it("他の人のコミットが届くと、その場で画面に反映する", async () => {
		const sockets: EventTarget[] = [];
		class CapturedSocket extends EventTarget {
			static readonly OPEN = 1;
			readonly readyState = 1;
			constructor() {
				super();
				sockets.push(this);
			}
			send() {}
			close() {}
		}
		vi.stubGlobal("WebSocket", CapturedSocket);
		stubFetch(() => json(saved));
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));
		// 接続は、編集欄を表示したあとで始まる。
		await waitFor(() => expect(sockets).toHaveLength(1));

		const commit = {
			type: "commit",
			version: 2,
			applied: [
				{ type: "insert", line: { id: "x", text: "他の人の行" }, after: "a", before: null },
			],
		};
		act(() => {
			sockets.at(-1)?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(commit) }));
		});

		expect(lines()).toEqual(["買い物", "他の人の行"]);
		expect(status()).toBe("保存済み");
	});

	it("コミットが続けて届いても、すべての行が画面に残り、自分からは何も送らない", async () => {
		const sockets: EventTarget[] = [];
		class CapturedSocket extends EventTarget {
			static readonly OPEN = 1;
			readonly readyState = 1;
			constructor() {
				super();
				sockets.push(this);
			}
			send() {}
			close() {}
		}
		vi.stubGlobal("WebSocket", CapturedSocket);
		const fetchMock = stubFetch(() => json(saved));
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));
		await waitFor(() => expect(sockets).toHaveLength(1));
		const insert = (version: number, id: string, after: string) => ({
			type: "commit",
			version,
			applied: [{ type: "insert", line: { id, text: id }, after, before: null }],
		});

		// 画面を描き直す間もなく、2つのコミットが続けて届く。
		act(() => {
			for (const commit of [insert(2, "x", "a"), insert(3, "y", "x")]) {
				sockets
					.at(-1)
					?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(commit) }));
			}
		});
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(lines()).toEqual(["買い物", "x", "y"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	describe("ページのつながり(ADR-0027)", () => {
		const card = (id: string, title: string) => ({
			id,
			title,
			descriptions: [],
			image: null,
			updated: 1000,
			created: 1000,
			linked: 0,
			pinned: false,
		});
		const relatedTitles = () =>
			within(screen.getByRole("region", { name: "関連するページ" }))
				.getAllByRole("listitem")
				.map((item) => within(item).getByRole("heading").textContent);

		it("ページの下に、関連するページを並べる", async () => {
			stubFetch(() => json(saved), {
				links: () => json({ ...NO_LINKS, related: [card("p2", "料理"), card("p3", "旅行")] }),
			});

			render(<Page name="買い物" />);

			await waitFor(() => expect(relatedTitles()).toEqual(["料理", "旅行"]));
		});

		it("まだないページへのリンクに、印を付ける", async () => {
			const withLinks = {
				version: 1,
				lines: [
					{ id: "a", text: "買い物" },
					{ id: "b", text: "[まだない] [ある]" },
				],
			};
			stubFetch(() => json(withLinks), {
				links: () => json({ ...NO_LINKS, missing: ["まだない"] }),
			});

			render(<Page name="買い物" />);

			await waitFor(() =>
				expect(screen.getByRole("link", { name: "まだない" }).getAttribute("data-missing")).toBe(
					"true",
				),
			);
			expect(screen.getByRole("link", { name: "ある" }).hasAttribute("data-missing")).toBe(false);
		});

		it("台帳への反映が済んだと知らされたら、つながりを取り出し直す", async () => {
			let related = [card("p2", "料理")];
			const { receive } = await openWithSocket({
				links: () => json({ ...NO_LINKS, related }),
			});
			await waitFor(() => expect(relatedTitles()).toEqual(["料理"]));

			related = [card("p2", "料理"), card("p3", "旅行")];
			receive({ type: "page", title: "買い物", problem: null });

			await waitFor(() => expect(relatedTitles()).toEqual(["料理", "旅行"]));
		});

		it("つながりを取り出せなくても、ページは読み書きできる。前に取り出したつながりは、そのまま見せる", async () => {
			let failing = false;
			const { receive } = await openWithSocket({
				links: () =>
					failing
						? json({ error: "x" }, 500)
						: json({ ...NO_LINKS, related: [card("p2", "料理")] }),
			});
			await waitFor(() => expect(relatedTitles()).toEqual(["料理"]));

			failing = true;
			receive({ type: "page", title: "買い物", problem: null });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(relatedTitles()).toEqual(["料理"]);
			expect(lines()).toEqual(["買い物"]);
		});

		it("リンクを書いている途中に、ページの名前の候補を出す(ADR-0030)", async () => {
			stubFetch(() => json(saved), { titles: ["買い物 メモ", "買い置き"] });
			render(<Page name="買い物" />);
			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			fireEvent.focus(screen.getByLabelText("ページの本文"));
			fireEvent.keyDown(screen.getByLabelText("ページの本文"), { key: "End" });

			type("\n[買い");

			await waitFor(() =>
				expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
					"買い物 メモ",
					"買い置き",
				]),
			);
		});

		it("つながりのないページでは、関連するページの欄を出さない", async () => {
			stubFetch(() => json(saved));

			render(<Page name="買い物" />);

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			expect(screen.queryByRole("region", { name: "関連するページ" })).toBeNull();
		});
	});

	describe("固定と削除(ADR-0026)", () => {
		it("保存されているページでは、固定と削除の操作を出す。固定しているかどうかが分かる", async () => {
			stubFetch(() => json(saved), { pinned: true });

			render(<Page name="買い物" />);

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			expect(screen.getByRole("button", { name: "固定を外す" })).toBeDefined();
			expect(screen.getByRole("button", { name: "このページを削除" })).toBeDefined();
		});

		it("まだ保存されていないページでは、固定と削除の操作を出さない", async () => {
			stubFetch(() => json({ version: 0, lines: [] }));

			render(<Page name="新しい_ページ" />);

			await waitFor(() => expect(lines()).toEqual(["新しい ページ"]));
			expect(screen.queryByRole("button", { name: "このページを削除" })).toBeNull();
		});

		it("固定すると、ボタンが「固定を外す」に変わる", async () => {
			stubFetch((_url, init) =>
				init?.method === "PUT"
					? json({ id: PAGE_ID, title: "買い物", problem: null, pinned: true })
					: json(saved),
			);
			render(<Page name="買い物" />);
			await waitFor(() => expect(lines()).toEqual(["買い物"]));

			fireEvent.click(screen.getByRole("button", { name: "一覧の先頭に固定する" }));

			await waitFor(() => expect(screen.getByRole("button", { name: "固定を外す" })).toBeDefined());
		});

		it("開いているページが削除されたと知らされたら、そのことを表示し、操作を出すのをやめる", async () => {
			const { receive } = await openWithSocket();

			receive({ type: "deleted" });

			expect(status()).toBe("このページは削除されました。ここに書いても、保存されません");
			expect(screen.queryByRole("button", { name: "このページを削除" })).toBeNull();
			// 書いてあった内容は、画面に残る(写しておける)。
			expect(lines()).toEqual(["買い物"]);
		});

		it("読み込もうとしたページが削除されていたら、そのことを伝え、一覧へ戻れるようにする", async () => {
			stubFetch(() => json({ error: "page-deleted" }, 410));

			render(<Page name="買い物" />);

			await waitFor(() => expect(screen.getByText(/このページは削除されました/)).toBeDefined());
			// プロジェクトのトップ(同じ階層)へ戻る。
			expect(screen.getByRole("link", { name: "ページの一覧" }).getAttribute("href")).toBe("./");
		});
	});

	describe("ページの名前(ADR-0024)", () => {
		const path = () => decodeURIComponent(window.location.pathname);

		it("名前からページを引けなければ、読み込みの失敗を表示する。やり直せる", async () => {
			let failing = true;
			vi.stubGlobal("fetch", async (url: string) => {
				if (failing) return json({ error: "x" }, 500);
				return url.startsWith(BY_TITLE)
					? json({ id: PAGE_ID, title: "買い物", problem: null, pinned: false })
					: json(saved);
			});
			render(<Page name="買い物" />);
			await waitFor(() => expect(screen.getByText(/ページを読み込めませんでした/)).toBeDefined());

			failing = false;
			fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
		});

		it("見る権限がなければ、名前を引く時点で、そのことを表示する", async () => {
			vi.stubGlobal("fetch", async () => json({ error: "read-only" }, 403));

			render(<Page name="買い物" />);

			await waitFor(() => expect(screen.getByText(/見る権限がありません/)).toBeDefined());
		});

		it("まだないページを、読むだけの人が開いたら、ないことを伝え、一覧へ戻れるようにする", async () => {
			vi.stubGlobal("fetch", async () => json({ error: "unknown-page" }, 404));

			render(<Page name="買い物" readOnly />);

			await waitFor(() => expect(screen.getByText(/このページは、まだありません/)).toBeDefined());
			expect(screen.getByRole("link", { name: "ページの一覧" }).getAttribute("href")).toBe("./");
		});

		it("引いたIDのページを読み込む。未送信の変更も、IDごとに残す", async () => {
			const fetchMock = stubFetch(() => json(saved));

			render(<Page name="買い物" />);

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			expect(fetchMock).toHaveBeenCalledWith(`/api/projects/team/pages/${PAGE_ID}`, undefined);
		});

		it("URLの名前が、ページの名前と表記だけ違うときは、URLをページの名前に合わせる", async () => {
			window.history.replaceState(null, "", "/team/kaimono_MEMO");
			stubFetch(() => json(saved), { title: "Kaimono Memo" });

			render(<Page name="kaimono_MEMO" />);

			// URLは、編集欄を表示したあとで合わせる。
			await waitFor(() => expect(path()).toBe("/team/Kaimono_Memo"));
			expect(lines()).toEqual(["買い物"]);
		});

		it("ページの名前が変わったと知らされたら、URLを新しい名前に合わせる(再読み込みしても同じページが開く)", async () => {
			window.history.replaceState(null, "", `/team/${encodeURIComponent("買い物")}`);
			const { receive } = await openWithSocket();

			receive({ type: "page", title: "買い物 メモ", problem: null });

			expect(path()).toBe("/team/買い物_メモ");
			expect(screen.queryByRole("note")).toBeNull();
		});

		it.each([
			["taken", "1行目と同じ名前のページが、すでにあります。"],
			["empty", "1行目が空です。"],
			["too-long", "1行目が長すぎて、ページの名前にできません(200文字まで)。"],
			["reserved", "「.」と「..」は、ページの名前にできません。"],
		])(
			"名前を1行目に合わせられないとき(%s)は、理由と、いまの名前を案内する",
			async (problem, reason) => {
				const { receive } = await openWithSocket();

				receive({ type: "page", title: "買い物", problem });

				expect(screen.getByTestId("title-problem").textContent).toBe(
					`${reason}このページの名前は「買い物」のままです。1行目を変えると、ページの名前も変わります。`,
				);
			},
		);

		it("名前を合わせられるようになったら、案内を消す", async () => {
			const { receive } = await openWithSocket();
			receive({ type: "page", title: "買い物", problem: "taken" });

			receive({ type: "page", title: "買い物2", problem: null });

			expect(screen.queryByTestId("title-problem")).toBeNull();
		});

		it("開いたときに、名前を1行目に合わせられていなければ、はじめから案内を出す", async () => {
			stubFetch(() => json(saved), { problem: "taken" });

			render(<Page name="買い物" />);

			await waitFor(() => expect(screen.getByTestId("title-problem")).toBeDefined());
		});
	});

	describe("他の人のカーソルと接続の状態(ADR-0023)", () => {
		const connection = () => screen.getByTestId("connection").textContent;
		const hello = { type: "hello", version: 1 };

		it("つながるまでは「接続しています…」、つながったら「オンライン」と表示する", async () => {
			const { receive } = await openWithSocket();
			expect(connection()).toBe("接続しています…");

			receive(hello);

			expect(connection()).toBe("オンライン");
		});

		it("接続が切れたら、つなぎ直していることを表示する", async () => {
			const { socket, receive } = await openWithSocket();
			receive(hello);

			act(() => {
				socket.dispatchEvent(new Event("close"));
			});

			expect(connection()).toBe("オフライン(つなぎ直しています…)");
		});

		it("他の人のカーソルが届くと、その行に表示する。その人が接続を閉じたら消す", async () => {
			const { receive } = await openWithSocket();
			receive(hello);

			receive({ type: "cursor", client: "bob", cursor: { line: "a", column: 1 } });
			const remote = screen.getByTestId("remote-caret");
			expect(remote.closest("[data-testid=line]")?.getAttribute("data-text")).toBe("買い物");
			expect(remote.nextElementSibling?.getAttribute("data-column")).toBe("1");

			receive({ type: "leave", client: "bob" });
			expect(screen.queryByTestId("remote-caret")).toBeNull();
		});

		it("接続が切れたら、他の人のカーソルを消す(切れているあいだの動きは分からない)", async () => {
			const { socket, receive } = await openWithSocket();
			receive(hello);
			receive({ type: "cursor", client: "bob", cursor: { line: "a", column: 1 } });

			act(() => {
				socket.dispatchEvent(new Event("close"));
			});

			expect(screen.queryByTestId("remote-caret")).toBeNull();
		});

		it("自分のカーソルの位置を、他の人に知らせる", async () => {
			const { socket, receive } = await openWithSocket();
			receive(hello);

			fireEvent.mouseDown(screen.getByTestId("line"));

			await waitFor(() => expect(socket.sent).toHaveLength(1));
			expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
				type: "cursor",
				cursor: { line: "a", column: 3 },
			});
		});
	});

	it("保存に失敗したら、再試行することを表示する", async () => {
		stubFetch((_url, init) => (init?.method === "POST" ? json({}, 500) : json(saved)));
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));

		fireEvent.mouseDown(screen.getByTestId("line"));
		type("牛乳");

		await waitFor(() => expect(status()).toBe("保存できませんでした。自動で再試行します"));
	});

	it("未保存の変更があるあいだは、ページを離れる前に確認を出す", async () => {
		stubFetch((_url, init) => (init?.method === "POST" ? new Promise(() => {}) : json(saved)));
		render(<Page name="買い物" />);
		await waitFor(() => expect(lines()).toEqual(["買い物"]));
		const leave = () => fireEvent(window, new Event("beforeunload", { cancelable: true }));

		expect(leave()).toBe(true);
		fireEvent.mouseDown(screen.getByTestId("line"));
		type("牛乳");

		expect(leave()).toBe(false);
	});

	it("読むだけの表示では、そのことを伝え、ページの操作(固定、削除)を出さない。本文は見える", async () => {
		stubFetch(() => json(saved));

		render(<Page name="買い物" readOnly />);

		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toMatch(/読むだけの表示です/),
		);
		await waitFor(() => expect(screen.getAllByTestId("line").length).toBeGreaterThan(0));
		expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true");
		// 入力を受け取る欄がない。
		expect(screen.queryByRole("textbox", { name: "ページの本文" })).toBeNull();
		expect(screen.queryByRole("button", { name: /固定/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /削除/ })).toBeNull();
	});

	it("読み込みに失敗したら、やり直せる", async () => {
		let attempts = 0;
		stubFetch(() => {
			attempts += 1;
			return attempts === 1 ? json({}, 500) : json(saved);
		});
		render(<Page name="買い物" />);

		fireEvent.click(await screen.findByRole("button", { name: "もう一度読み込む" }));

		await waitFor(() => expect(lines()).toEqual(["買い物"]));
	});
});
