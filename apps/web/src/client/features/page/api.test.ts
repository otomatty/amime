import type { ClientId, Commit, CommitId, LineId, PageId } from "@amime/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPageApi,
	deletePage,
	listPages,
	loadLinks,
	openPage,
	pageSocketUrl,
	pinPage,
	searchPages,
	searchTitles,
} from "./api.ts";
import { PageApiError } from "./page-api-error.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(response: Response | Error) {
	const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
		if (response instanceof Error) throw response;
		return response;
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const client = "tab-1" as ClientId;
const pageId = "p-1" as PageId;

describe("openPage(名前からページを引く)", () => {
	const info = { id: "p-1", title: "買い物/メモ", problem: null, pinned: false };

	it("名前をURLに符号化して引く。ページのIDと名前を返す", async () => {
		const fetchMock = stubFetch(json(info));

		expect(await openPage("買い物/メモ")).toEqual(info);
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/pages/by-title/${encodeURIComponent("買い物/メモ")}`,
			undefined,
		);
	});

	it("ページのAPIが無効な環境では、そのことが分かる失敗になる", async () => {
		stubFetch(json({ error: "page-api-disabled" }, 403));

		await expect(openPage("a")).rejects.toMatchObject({ kind: "disabled" });
	});

	it("形の違う応答は、読み込みの失敗になる", async () => {
		stubFetch(json({ id: "p-1" }));

		await expect(openPage("a")).rejects.toMatchObject({ kind: "failed" });
	});
});

describe("listPages(ページの一覧)", () => {
	const list = { pages: [], total: 0 };

	it("並び順と、何件目から取り出すかを指定して取り出す", async () => {
		const fetchMock = stubFetch(json(list));

		expect(await listPages({ sort: "linked", offset: 100 })).toEqual(list);
		expect(fetchMock).toHaveBeenCalledWith("/api/pages?sort=linked&offset=100", undefined);
	});

	it("形の違う応答は、読み込みの失敗になる", async () => {
		stubFetch(json({ pages: [] }));

		await expect(listPages({ sort: "updated", offset: 0 })).rejects.toMatchObject({
			kind: "failed",
		});
	});
});

describe("searchTitles(名前でページを探す)", () => {
	it("入力をURLに符号化して送り、合う名前を返す", async () => {
		const fetchMock = stubFetch(json({ titles: ["買い物 メモ"] }));

		expect(await searchTitles("買い物 &メモ")).toEqual(["買い物 メモ"]);
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/pages/titles?q=${encodeURIComponent("買い物 &メモ")}`,
			undefined,
		);
	});

	it("失敗は、PageApiError になる", async () => {
		stubFetch(json({ error: "page-api-disabled" }, 403));

		await expect(searchTitles("a")).rejects.toMatchObject({ kind: "disabled" });
	});
});

describe("searchPages(本文を探す)", () => {
	it("入力をURLに符号化して送り、結果を返す", async () => {
		const results = {
			hits: [{ id: "p-1", title: "買い物", updated: 1000, lines: ["牛乳を買う"] }],
			more: false,
		};
		const fetchMock = stubFetch(json(results));

		expect(await searchPages("牛乳 &卵")).toEqual(results);
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/pages/search?q=${encodeURIComponent("牛乳 &卵")}`,
			undefined,
		);
	});

	it("失敗は、PageApiError になる", async () => {
		stubFetch(json({ error: "x" }, 500));

		await expect(searchPages("a")).rejects.toMatchObject({ kind: "failed" });
	});
});

describe("loadLinks(ページのつながり)", () => {
	it("ページのIDを指して、つながりを取り出す", async () => {
		const links = { missing: ["まだない"], related: [], hops: [] };
		const fetchMock = stubFetch(json(links));

		expect(await loadLinks(pageId)).toEqual(links);
		expect(fetchMock).toHaveBeenCalledWith("/api/pages/p-1/links", undefined);
	});

	it("形の違う応答は、失敗として扱う", async () => {
		stubFetch(json({ version: 1, lines: [] }));

		await expect(loadLinks(pageId)).rejects.toMatchObject({ kind: "failed" });
	});
});

describe("pinPage(一覧の先頭に固定する)", () => {
	const info = { id: "p-1", title: "買い物", problem: null, pinned: true };

	it("固定するかどうかを送り、ページの情報を返す", async () => {
		const fetchMock = stubFetch(json(info));

		expect(await pinPage(pageId, true)).toEqual(info);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/api/pages/p-1/pin");
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual({ pinned: true });
	});

	it("失敗は、PageApiError になる", async () => {
		stubFetch(json({ error: "unknown-page" }, 404));

		await expect(pinPage(pageId, false)).rejects.toMatchObject({ kind: "failed" });
	});
});

describe("deletePage(ページを削除する)", () => {
	it("ページのIDを指して削除する", async () => {
		const fetchMock = stubFetch(new Response(null, { status: 204 }));

		await deletePage(pageId);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("/api/pages/p-1");
		expect(init?.method).toBe("DELETE");
	});

	it.each([
		["サーバーの失敗", json({ error: "x" }, 500), "failed"],
		["通信の失敗", new TypeError("network"), "failed"],
		["ページのAPIが無効", json({ error: "page-api-disabled" }, 403), "disabled"],
	])("%sは、PageApiError になる", async (_name, response, kind) => {
		stubFetch(response);

		await expect(deletePage(pageId)).rejects.toMatchObject({ kind });
	});
});

describe("pageSocketUrl", () => {
	it("いま開いているページと同じ接続先の、WebSocket のURLを作る", () => {
		const page = new URL("https://amime.example/notes/x");

		expect(pageSocketUrl(page, pageId, client)).toBe(
			"wss://amime.example/api/pages/p-1/socket?client=tab-1",
		);
	});

	it("http で開いているときは、暗号化しない接続にする(手元での開発)", () => {
		const page = new URL("http://localhost:5173/");

		expect(pageSocketUrl(page, pageId, client)).toBe(
			"ws://localhost:5173/api/pages/p-1/socket?client=tab-1",
		);
	});
});

describe("createPageApi", () => {
	const api = createPageApi(pageId, client);
	const snapshot = { version: 2, lines: [{ id: "a", text: "題" }] };

	describe("load", () => {
		it("ページのIDを指して読み込む", async () => {
			const fetchMock = stubFetch(json(snapshot));

			expect(await api.load()).toEqual(snapshot);
			expect(fetchMock).toHaveBeenCalledWith("/api/pages/p-1", undefined);
		});

		it("ページのAPIが無効な環境では、そのことが分かる失敗になる", async () => {
			stubFetch(json({ error: "page-api-disabled" }, 403));

			await expect(api.load()).rejects.toMatchObject({ kind: "disabled" });
		});

		it("削除されたページでは、そのことが分かる失敗になる", async () => {
			stubFetch(json({ error: "page-deleted" }, 410));

			await expect(api.load()).rejects.toMatchObject({ kind: "gone" });
		});

		it.each([
			["サーバーの失敗", json({ error: "x" }, 500)],
			["通信の失敗", new TypeError("network")],
			["形の違う応答", json({ version: "x" })],
			["JSONでない応答", new Response("<html>", { status: 200 })],
		])("%sは、読み込みの失敗になる", async (_name, response) => {
			stubFetch(response);

			const error = await api.load().catch((reason: unknown) => reason);

			expect(error).toBeInstanceOf(PageApiError);
			expect(error).toMatchObject({ kind: "failed" });
		});
	});

	describe("commit", () => {
		const changes = [{ type: "delete", id: "a" as LineId }] as const;
		const commit: Commit = { id: "c1" as CommitId, changes };

		it("変更をJSONで送り、結果を返す", async () => {
			const fetchMock = stubFetch(json({ version: 3, applied: changes }));

			expect(await api.commit(commit)).toEqual({ version: 3, applied: changes });
			expect(fetchMock).toHaveBeenCalledWith("/api/pages/p-1/commits", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "c1", changes, client: "tab-1" }),
			});
		});

		it.each([
			["形が正しくない(400)", 400],
			["大きすぎる(413)", 413],
		])("内容が%sと断られたら、送り直しても通らない失敗になる", async (_name, status) => {
			stubFetch(json({ error: "invalid-commit" }, status));

			await expect(api.commit(commit)).rejects.toMatchObject({ kind: "rejected" });
		});

		it("サーバーの失敗は、送り直せる失敗になる", async () => {
			stubFetch(json({}, 503));

			await expect(api.commit(commit)).rejects.toMatchObject({ kind: "failed" });
		});
	});
});
