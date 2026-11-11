import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LineView } from "./line-view.tsx";

afterEach(cleanup);

describe("LineView", () => {
	it("インデントのない行は本文をそのまま表示し、行頭の印を出さない", () => {
		render(<LineView text="タイトル" />);

		const line = screen.getByText("タイトル").closest("[data-indent]");
		expect(line?.getAttribute("data-indent")).toBe("0");
		expect(screen.queryByTestId("bullet")).toBeNull();
	});

	it("インデントされた行は深さを反映し、行頭の空白を表示せず、印を出す", () => {
		render(<LineView text={" \t箇条書き"} />);

		const line = screen.getByText("箇条書き").closest("[data-indent]");
		expect(line?.getAttribute("data-indent")).toBe("2");
		expect(screen.getByTestId("bullet")).toBeDefined();
	});
});
