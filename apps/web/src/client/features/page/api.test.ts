import type { Change, LineId } from "@amime/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPageApi, PageApiError } from "./api.ts";

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

describe("createPageApi", () => {
	const api = createPageApi("買い物/メモ");
	const snapshot = { version: 2, lines: [{ id: "a", text: "題" }] };

	describe("load", () => {
		it("ページ名をURLに符号化して読み込む", async () => {
			const fetchMock = stubFetch(json(snapshot));

			expect(await api.load()).toEqual(snapshot);
			expect(fetchMock).toHaveBeenCalledWith(
				`/api/pages/${encodeURIComponent("買い物/メモ")}`,
				undefined,
			);
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
		const changes: Change[] = [{ type: "delete", id: "a" as LineId }];

		it("変更をJSONで送り、結果を返す", async () => {
			const fetchMock = stubFetch(json({ version: 3, applied: changes }));

			expect(await api.commit(changes)).toEqual({ version: 3, applied: changes });
			expect(fetchMock).toHaveBeenCalledWith(
				`/api/pages/${encodeURIComponent("買い物/メモ")}/commits`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ changes }),
				},
			);
		});

		it("断られたら失敗になる", async () => {
			stubFetch(json({ error: "invalid-commit" }, 400));

			await expect(api.commit(changes)).rejects.toBeInstanceOf(PageApiError);
		});
	});
});
