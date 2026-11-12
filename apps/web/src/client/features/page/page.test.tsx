import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "./page.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const lines = () => screen.getAllByTestId("line").map((line) => line.getAttribute("data-text"));
const status = () => screen.getByRole("status").textContent;
const type = (text: string) =>
	fireEvent.input(screen.getByLabelText("ページの本文"), { target: { value: text } });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("Page", () => {
	const saved = { version: 1, lines: [{ id: "a", text: "買い物" }] };

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
