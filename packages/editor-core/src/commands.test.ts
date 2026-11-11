import { InvariantError } from "@amime/shared";
import { describe, expect, it } from "vitest";
import {
	deleteBackward,
	deleteForward,
	indentLine,
	insertText,
	outdentLine,
	splitLine,
} from "./commands.ts";
import type { EditorState } from "./types.ts";

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});

const THUMBS_UP = "👍";

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

	it("空文字列の挿入は何も変えない", () => {
		const before = state(["a"], 0, 1);
		expect(insertText(before, "")).toBe(before);
	});

	it("改行を含む文字列は複数行として挿入し、カーソルを挿入した末尾に置く", () => {
		expect(insertText(state(["ab"], 0, 1), "x\ny\nz")).toEqual(state(["ax", "y", "zb"], 2, 1));
	});

	it("貼り付けた行のインデントはそのまま保ち、挿入先のインデントを足さない", () => {
		expect(insertText(state([" item"], 0, 5), "\n  child")).toEqual(
			state([" item", "  child"], 1, 7),
		);
	});

	it("CRLF と CR は改行として扱う", () => {
		expect(insertText(state([""], 0, 0), "a\r\nb\rc")).toEqual(state(["a", "b", "c"], 2, 1));
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

describe("deleteBackward", () => {
	it("カーソルの直前の1文字を消す", () => {
		expect(deleteBackward(state(["abc"], 0, 2))).toEqual(state(["ac"], 0, 1));
	});

	it("絵文字は1回で丸ごと消す", () => {
		expect(deleteBackward(state([`a${THUMBS_UP}b`], 0, 3))).toEqual(state(["ab"], 0, 1));
	});

	it("インデントの空白も1文字として消せる(1段浅くなる)", () => {
		expect(deleteBackward(state(["  item"], 0, 2))).toEqual(state([" item"], 0, 1));
	});

	it("行頭では前の行とつなげ、カーソルをつなぎ目に置く", () => {
		expect(deleteBackward(state(["ab", "cd", "ef"], 1, 0))).toEqual(state(["abcd", "ef"], 0, 2));
	});

	it("ページの先頭では何も変えない", () => {
		const before = state(["ab"], 0, 0);
		expect(deleteBackward(before)).toBe(before);
	});
});

describe("deleteForward", () => {
	it("カーソルの直後の1文字を消す", () => {
		expect(deleteForward(state(["abc"], 0, 1))).toEqual(state(["ac"], 0, 1));
	});

	it("絵文字は1回で丸ごと消す", () => {
		expect(deleteForward(state([`a${THUMBS_UP}b`], 0, 1))).toEqual(state(["ab"], 0, 1));
	});

	it("行末では次の行とつなげ、カーソルは動かさない", () => {
		expect(deleteForward(state(["ab", "cd", "ef"], 0, 2))).toEqual(state(["abcd", "ef"], 0, 2));
	});

	it("ページの末尾では何も変えない", () => {
		const before = state(["ab"], 0, 2);
		expect(deleteForward(before)).toBe(before);
	});
});

describe("indentLine", () => {
	it("カーソルのある行を1段深くし、カーソルは同じ文字の位置に留まる", () => {
		expect(indentLine(state(["a", "item"], 1, 2))).toEqual(state(["a", " item"], 1, 3));
	});
});

describe("outdentLine", () => {
	it("カーソルのある行を1段浅くし、カーソルは同じ文字の位置に留まる", () => {
		expect(outdentLine(state(["\t item"], 0, 4))).toEqual(state([" item"], 0, 3));
	});

	it("カーソルが行頭にあるときは行頭に留まる", () => {
		expect(outdentLine(state([" item"], 0, 0))).toEqual(state(["item"], 0, 0));
	});

	it("インデントのない行では何も変えない", () => {
		const before = state(["item"], 0, 2);
		expect(outdentLine(before)).toBe(before);
	});
});
