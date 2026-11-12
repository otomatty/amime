import { describe, expect, it } from "vitest";
import { lineSelection } from "./line-selection.ts";

const range = { start: { line: 1, column: 2 }, end: { line: 3, column: 1 } };
const NONE = { start: null, end: null, lineBreak: false };

describe("lineSelection", () => {
	it("選択していなければ、どの行も選択なし", () => {
		expect(lineSelection(null, 0, 5)).toEqual(NONE);
	});

	it("選択の外の行は、選択なし", () => {
		expect(lineSelection(range, 0, 5)).toEqual(NONE);
		expect(lineSelection(range, 4, 5)).toEqual(NONE);
	});

	it("選択が始まる行は、始まりの位置から行末までと、改行", () => {
		expect(lineSelection(range, 1, 5)).toEqual({ start: 2, end: 5, lineBreak: true });
	});

	it("選択の途中の行は、行全体と改行", () => {
		expect(lineSelection(range, 2, 4)).toEqual({ start: 0, end: 4, lineBreak: true });
	});

	it("選択が終わる行は、行頭から終わりの位置まで。改行は含まない", () => {
		expect(lineSelection(range, 3, 5)).toEqual({ start: 0, end: 1, lineBreak: false });
	});

	it("1行の中の選択は、その範囲だけ", () => {
		const single = { start: { line: 2, column: 1 }, end: { line: 2, column: 3 } };

		expect(lineSelection(single, 2, 5)).toEqual({ start: 1, end: 3, lineBreak: false });
	});
});
