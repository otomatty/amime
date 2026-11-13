import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

describe("App", () => {
	it("プロダクト名を見出しとして表示する", () => {
		render(<App />);

		expect(screen.getByRole("heading", { level: 1, name: "Amime" })).toBeDefined();
	});

	it("見出しから、トップ(ページの一覧)へ移れる", () => {
		render(<App />);

		expect(screen.getByRole("link", { name: "Amime" }).getAttribute("href")).toBe("/");
	});

	it("トップでは、ページの一覧を表示する", async () => {
		const list = { pages: [], total: 0 };
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(list)));

		render(<App />);

		await waitFor(() => expect(screen.getByText(/まだページがありません/)).toBeDefined());
		expect(screen.getByRole("region", { name: "ページの一覧" })).toBeDefined();
	});

	it("ページのAPIが無効な環境では、トップに、保存されない試し書きのページを表示する", async () => {
		const body = JSON.stringify({ error: "page-api-disabled" });
		vi.stubGlobal("fetch", async () => new Response(body, { status: 403 }));

		render(<App />);

		await waitFor(() => expect(screen.getByText(/この画面は試し書き用です/)).toBeDefined());
		expect(screen.getAllByTestId("line").length).toBeGreaterThan(1);
		// 探せるページがないので、探す欄も出さない。
		expect(screen.queryByRole("combobox", { name: "ページを探す" })).toBeNull();
	});

	it("名前でページを探す欄を出す(どのページからでも探せる)", async () => {
		vi.stubGlobal("fetch", async (url: string) =>
			url.startsWith("/api/pages/titles")
				? new Response(JSON.stringify({ titles: ["買い物"] }))
				: new Promise<Response>(() => {}),
		);
		window.history.replaceState(null, "", `/${encodeURIComponent("メモ")}`);

		render(<App />);

		await waitFor(() =>
			expect(screen.getByRole("combobox", { name: "ページを探す" })).toBeDefined(),
		);
	});

	it("URLに ?q= で語が付いていれば、本文を探した結果を表示する(一覧は読み込まない)", async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url.startsWith("/api/pages/search")
				? new Response(
						JSON.stringify({
							hits: [{ id: "p1", title: "買い物", updated: 1000, lines: ["牛乳を買う"] }],
							more: false,
						}),
					)
				: new Response(JSON.stringify({ titles: [] })),
		);
		vi.stubGlobal("fetch", fetchMock);
		window.history.replaceState(null, "", `/?q=${encodeURIComponent(" 牛乳 ")}`);

		render(<App />);

		await waitFor(() => expect(screen.getByRole("link", { name: "買い物" })).toBeDefined());
		expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
			"「牛乳」を本文から探した結果",
		);
		expect(screen.queryByRole("region", { name: "ページの一覧" })).toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
			"/api/pages?sort=updated&offset=0",
		);
	});

	it("URLに ?playground を付けると、試し書きのページを表示する(一覧は読み込まない)", async () => {
		const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ titles: [] })));
		vi.stubGlobal("fetch", fetchMock);
		window.history.replaceState(null, "", "/?playground");

		render(<App />);

		expect(screen.getByText(/この画面は試し書き用です/)).toBeDefined();
		// 名前で探す欄のための問い合わせだけを行う。
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/pages/titles?q="]);
	});

	it("トップ以外のパスでは、その名前のページを読み込む", async () => {
		const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal("fetch", fetchMock);
		window.history.replaceState(null, "", `/${encodeURIComponent("メモ")}`);

		render(<App />);

		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				`/api/pages/by-title/${encodeURIComponent("メモ")}`,
				undefined,
			),
		);
		expect(screen.getByRole("status").textContent).toBe("読み込んでいます…");
	});
});
