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

	it("トップでは、保存されない試し書きのページを表示する", () => {
		render(<App />);

		expect(screen.getAllByTestId("line").length).toBeGreaterThan(1);
		expect(screen.getByText(/この画面は試し書き用です/)).toBeDefined();
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
