import type { ClientId, Commit, CommitId, LineId, PageId } from "@amime/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPageApi, openPage, pageSocketUrl } from "./api.ts";
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
	const info = { id: "p-1", title: "買い物/メモ", problem: null };

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
