import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "./page.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** テストで開くページのID。 */
const PAGE_ID = "p1";
const BY_TITLE = "/api/pages/by-title/";

/**
 * fetch を差し替える。名前からページを引く要求には、決まったIDと、URLの名前から作った名前を返す。
 * それ以外の要求(ページの読み込みと、コミット)を handler に渡す。返すのは、handler の呼び出しの記録。
 */
function stubFetch(handler: Handler, info: { title?: string; problem?: string | null } = {}) {
	const fetchMock = vi.fn(handler);
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		if (!url.startsWith(BY_TITLE)) return fetchMock(url, init);
		const name = decodeURIComponent(url.slice(BY_TITLE.length));
		const title = info.title ?? name.replaceAll("_", " ");
		return json({ id: PAGE_ID, title, problem: info.problem ?? null });
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
async function openWithSocket() {
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
	stubFetch(() => json(SAVED));
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
			await waitFor(() => expect(status()).toBe("保存済み"));
			const commit = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
			expect(JSON.parse(String(commit?.[1]?.body))).toMatchObject({
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

	describe("ページの名前(ADR-0024)", () => {
		const path = () => decodeURIComponent(window.location.pathname);

		it("名前からページを引けなければ、読み込みの失敗を表示する。やり直せる", async () => {
			let failing = true;
			vi.stubGlobal("fetch", async (url: string) => {
				if (failing) return json({ error: "x" }, 500);
				return url.startsWith(BY_TITLE)
					? json({ id: PAGE_ID, title: "買い物", problem: null })
					: json(saved);
			});
			render(<Page name="買い物" />);
			await waitFor(() => expect(screen.getByText(/ページを読み込めませんでした/)).toBeDefined());

			failing = false;
			fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
		});

		it("ページのAPIが無効な環境では、名前を引く時点で、そのことを表示する", async () => {
			vi.stubGlobal("fetch", async () => json({ error: "page-api-disabled" }, 403));

			render(<Page name="買い物" />);

			await waitFor(() => expect(screen.getByText(/まだ使えません/)).toBeDefined());
		});

		it("引いたIDのページを読み込む。未送信の変更も、IDごとに残す", async () => {
			const fetchMock = stubFetch(() => json(saved));

			render(<Page name="買い物" />);

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}`, undefined);
		});

		it("URLの名前が、ページの名前と表記だけ違うときは、URLをページの名前に合わせる", async () => {
			window.history.replaceState(null, "", "/notes/kaimono_MEMO");
			stubFetch(() => json(saved), { title: "Kaimono Memo" });

			render(<Page name="kaimono_MEMO" />);

			await waitFor(() => expect(lines()).toEqual(["買い物"]));
			expect(path()).toBe("/notes/Kaimono_Memo");
		});

		it("ページの名前が変わったと知らされたら、URLを新しい名前に合わせる(再読み込みしても同じページが開く)", async () => {
			window.history.replaceState(null, "", `/${encodeURIComponent("買い物")}`);
			const { receive } = await openWithSocket();

			receive({ type: "page", title: "買い物 メモ", problem: null });

			expect(path()).toBe("/買い物_メモ");
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

	it("ページのAPIが無効な環境では、使えないことを伝える", async () => {
		stubFetch(() => json({ error: "page-api-disabled" }, 403));

		render(<Page name="買い物" />);

		expect(
			await screen.findByText(/この環境では、ページの保存と読み込みはまだ使えません/),
		).toBeDefined();
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
