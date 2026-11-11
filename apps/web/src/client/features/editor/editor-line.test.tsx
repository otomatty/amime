import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EditorLine } from "./editor-line.tsx";

afterEach(cleanup);

const line = () => screen.getByTestId("line");

describe("EditorLine", () => {
	it("本文を1文字ずつ、開始位置と終了位置を付けて描画する", () => {
		render(<EditorLine index={0} text="a👍" caretColumn={null} composing={null} />);

		const chars = [...line().querySelectorAll("[data-column]")];
		expect(
			chars.map((c) => [c.textContent, c.getAttribute("data-column"), c.getAttribute("data-end")]),
		).toEqual([
			["a", "0", "1"],
			["👍", "1", "3"],
		]);
	});

	it("行頭の空白は文字として表示せず、インデントの深さとして描画する", () => {
		render(<EditorLine index={2} text={" \t箇条書き"} caretColumn={null} composing={null} />);

		expect(line().textContent).toBe("箇条書き");
		expect(line().getAttribute("data-indent")).toBe("2");
		expect(line().getAttribute("data-line")).toBe("2");
		expect(line().querySelectorAll(".indent")).toHaveLength(2);
	});

	it("箇条書きの印は、最後のインデントに1つだけ付く", () => {
		render(<EditorLine index={0} text="  item" caretColumn={null} composing={null} />);

		const indents = [...line().querySelectorAll(".indent")];
		expect(indents.map((i) => i.hasAttribute("data-bullet"))).toEqual([false, true]);
	});

	it("インデントのない行には印を付けない", () => {
		render(<EditorLine index={0} text="title" caretColumn={null} composing={null} />);

		expect(line().querySelector("[data-bullet]")).toBeNull();
	});

	it("カーソルのない行にはカーソルを描画しない", () => {
		render(<EditorLine index={0} text="abc" caretColumn={null} composing={null} />);

		expect(screen.queryByTestId("caret")).toBeNull();
	});

	it.each([
		[0, ""],
		[2, "ab"],
		[3, "abc"],
	])("カーソルを文字位置 %i に描画する", (caretColumn, before) => {
		render(<EditorLine index={0} text="abc" caretColumn={caretColumn} composing={null} />);

		expect(textBefore(screen.getByTestId("caret"))).toBe(before);
	});

	it("カーソルはインデントの中にも置ける", () => {
		render(<EditorLine index={0} text="  item" caretColumn={1} composing={null} />);

		const caret = screen.getByTestId("caret");
		expect(caret.previousElementSibling?.getAttribute("data-column")).toBe("0");
		expect(caret.nextElementSibling?.getAttribute("data-column")).toBe("1");
	});

	it("変換中の文字列を、カーソルの直前に下線付きの領域として描画する", () => {
		render(<EditorLine index={0} text="ab" caretColumn={1} composing="にほんご" />);

		const composing = screen.getByTestId("composing");
		expect(composing.textContent).toBe("にほんご");
		expect(textBefore(composing)).toBe("a");
		expect(composing.nextElementSibling).toBe(screen.getByTestId("caret"));
	});

	it("変換中でなければ、変換中の領域を描画しない", () => {
		render(<EditorLine index={0} text="ab" caretColumn={1} composing={null} />);

		expect(screen.queryByTestId("composing")).toBeNull();
	});
});

/** 同じ行の中で、指定した要素より前にある文字列。 */
function textBefore(element: Element): string {
	let text = "";
	for (let node = element.previousSibling; node; node = node.previousSibling) {
		text = (node.textContent ?? "") + text;
	}
	return text;
}
