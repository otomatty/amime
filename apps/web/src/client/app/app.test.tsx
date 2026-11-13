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
	});

	it("URLに ?playground を付けると、試し書きのページを表示する(一覧は読み込まない)", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		window.history.replaceState(null, "", "/?playground");

		render(<App />);

		expect(screen.getByText(/この画面は試し書き用です/)).toBeDefined();
		expect(fetchMock).not.toHaveBeenCalled();
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
