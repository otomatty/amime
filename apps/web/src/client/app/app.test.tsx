import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./app.tsx";

afterEach(cleanup);

describe("App", () => {
	it("プロダクト名を見出しとして表示する", () => {
		render(<App />);

		expect(screen.getByRole("heading", { level: 1, name: "Amime" })).toBeDefined();
	});

	it("サンプルページの行を表示する", () => {
		render(<App />);

		expect(screen.getAllByTestId("line").length).toBeGreaterThan(1);
	});
});
