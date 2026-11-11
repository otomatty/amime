import { InvariantError } from "@amime/shared";
import { describe, expect, it } from "vitest";
import { insertText, splitLine } from "./commands.ts";
import type { EditorState } from "./types.ts";

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});

describe("insertText", () => {
	it("カーソル位置に文字を挿入し、カーソルを挿入した文字数だけ進める", () => {
		expect(insertText(state(["helo"], 0, 3), "l")).toEqual(state(["hello"], 0, 4));
	});

	it("他の行には触れない", () => {
		expect(insertText(state(["a", "b", "c"], 1, 1), "!")).toEqual(state(["a", "b!", "c"], 1, 2));
	});

	it("元の状態を書き換えない", () => {
		const before = state(["a"], 0, 1);
		insertText(before, "b");
		expect(before).toEqual(state(["a"], 0, 1));
	});

	it("改行を含む文字列は受け付けない(複数行の貼り付けは別コマンドの責務)", () => {
		expect(() => insertText(state(["a"], 0, 0), "x\ny")).toThrow(InvariantError);
	});

	it("カーソルが行の範囲外なら不変条件違反", () => {
		expect(() => insertText(state(["a"], 3, 0), "x")).toThrow(InvariantError);
		expect(() => insertText(state(["a"], 0, 9), "x")).toThrow(InvariantError);
	});
});

describe("splitLine", () => {
	it("カーソル位置で行を分割し、カーソルを次の行の先頭に移す", () => {
		expect(splitLine(state(["hello world"], 0, 5))).toEqual(state(["hello", " world"], 1, 0));
	});

	it("行末で分割すると空行ができる", () => {
		expect(splitLine(state(["title"], 0, 5))).toEqual(state(["title", ""], 1, 0));
	});

	it("インデントされた行では、新しい行が同じインデントを引き継ぐ", () => {
		expect(splitLine(state([" \titem"], 0, 6))).toEqual(state([" \titem", " \t"], 1, 2));
	});

	it("インデントされた行の途中で分割しても、後半が同じインデントで始まる", () => {
		expect(splitLine(state(["  abcd"], 0, 4))).toEqual(state(["  ab", "  cd"], 1, 2));
	});

	it("行頭で分割すると、行全体がそのまま下に移る", () => {
		expect(splitLine(state([" item"], 0, 0))).toEqual(state(["", " item"], 1, 0));
	});

	it("後続の行は保たれる", () => {
		expect(splitLine(state(["ab", "next"], 0, 1))).toEqual(state(["a", "b", "next"], 1, 0));
	});
});
