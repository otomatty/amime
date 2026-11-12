import { InvariantError } from "@amime/shared";
import { describe, expect, it } from "vitest";
import {
	moveDown,
	moveLeft,
	moveRight,
	moveToLineEnd,
	moveToLineStart,
	moveUp,
	setCursor,
} from "./motion.ts";
import type { EditorState } from "./types.ts";

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});

const THUMBS_UP = "👍";

describe("moveLeft", () => {
	it("1文字左へ動く", () => {
		expect(moveLeft(state(["abc"], 0, 2)).cursor).toEqual({ line: 0, column: 1 });
	});

	it("絵文字を1回でまたぐ", () => {
		expect(moveLeft(state([`a${THUMBS_UP}`], 0, 3)).cursor).toEqual({ line: 0, column: 1 });
	});

	it("行頭では前の行の末尾へ移る", () => {
		expect(moveLeft(state(["ab", "cd"], 1, 0)).cursor).toEqual({ line: 0, column: 2 });
	});

	it("ページの先頭では動かない", () => {
		const before = state(["ab"], 0, 0);
		expect(moveLeft(before)).toBe(before);
	});
});

describe("moveRight", () => {
	it("1文字右へ動く", () => {
		expect(moveRight(state(["abc"], 0, 1)).cursor).toEqual({ line: 0, column: 2 });
	});

	it("絵文字を1回でまたぐ", () => {
		expect(moveRight(state([`a${THUMBS_UP}`], 0, 1)).cursor).toEqual({ line: 0, column: 3 });
	});

	it("行末では次の行の先頭へ移る", () => {
		expect(moveRight(state(["ab", "cd"], 0, 2)).cursor).toEqual({ line: 1, column: 0 });
	});

	it("ページの末尾では動かない", () => {
		const before = state(["ab"], 0, 2);
		expect(moveRight(before)).toBe(before);
	});
});

describe("moveUp", () => {
	it("同じ文字位置のまま1行上へ動く", () => {
		expect(moveUp(state(["abcd", "efgh"], 1, 3)).cursor).toEqual({ line: 0, column: 3 });
	});

	it("上の行が短ければ行末に合わせる", () => {
		expect(moveUp(state(["ab", "efgh"], 1, 4)).cursor).toEqual({ line: 0, column: 2 });
	});

	it("絵文字の途中には止まらない", () => {
		expect(moveUp(state([`a${THUMBS_UP}`, "efgh"], 1, 2)).cursor).toEqual({ line: 0, column: 1 });
	});

	it("先頭の行では行頭へ動く", () => {
		expect(moveUp(state(["abcd"], 0, 3)).cursor).toEqual({ line: 0, column: 0 });
	});
});

describe("moveDown", () => {
	it("同じ文字位置のまま1行下へ動く", () => {
		expect(moveDown(state(["abcd", "efgh"], 0, 3)).cursor).toEqual({ line: 1, column: 3 });
	});

	it("下の行が短ければ行末に合わせる", () => {
		expect(moveDown(state(["abcd", "ef"], 0, 4)).cursor).toEqual({ line: 1, column: 2 });
	});

	it("最後の行では行末へ動く", () => {
		expect(moveDown(state(["abcd"], 0, 1)).cursor).toEqual({ line: 0, column: 4 });
	});
});

describe("moveToLineStart / moveToLineEnd", () => {
	it("行頭へ動く", () => {
		expect(moveToLineStart(state(["a", "bcd"], 1, 2)).cursor).toEqual({ line: 1, column: 0 });
	});

	it("行末へ動く", () => {
		expect(moveToLineEnd(state(["a", "bcd"], 1, 1)).cursor).toEqual({ line: 1, column: 3 });
	});
});

describe("setCursor", () => {
	it("指定した位置へ動く", () => {
		expect(setCursor(state(["ab", "cd"], 0, 0), { line: 1, column: 1 }).cursor).toEqual({
			line: 1,
			column: 1,
		});
	});

	it("範囲外の行と文字位置は、存在する範囲に収める", () => {
		const before = state(["ab", "cd"], 0, 0);
		expect(setCursor(before, { line: 9, column: 9 }).cursor).toEqual({ line: 1, column: 2 });
		expect(setCursor(before, { line: -1, column: -1 }).cursor).toEqual({ line: 0, column: 0 });
	});

	it("絵文字の途中を指定されたら、その文字の前に寄せる", () => {
		expect(setCursor(state([`a${THUMBS_UP}`], 0, 0), { line: 0, column: 2 }).cursor).toEqual({
			line: 0,
			column: 1,
		});
	});

	it("行が1つもない状態は不変条件違反", () => {
		expect(() => setCursor(state([], 0, 0), { line: 0, column: 0 })).toThrow(InvariantError);
	});

	it("行は変えない", () => {
		const before = state(["ab"], 0, 0);
		expect(setCursor(before, { line: 0, column: 1 }).lines).toBe(before.lines);
	});
});

describe("範囲を選択しているときの移動", () => {
	const selecting = (lines: string[], anchor: [number, number], cursor: [number, number]) => ({
		lines,
		anchor: { line: anchor[0], column: anchor[1] },
		cursor: { line: cursor[0], column: cursor[1] },
	});

	it("左へ動くと、選択をやめてカーソルを選択の始まりに置く", () => {
		expect(moveLeft(selecting(["abcd", "ef"], [1, 1], [0, 1]))).toEqual(
			state(["abcd", "ef"], 0, 1),
		);
		expect(moveLeft(selecting(["abcd"], [0, 1], [0, 3]))).toEqual(state(["abcd"], 0, 1));
	});

	it("右へ動くと、選択をやめてカーソルを選択の終わりに置く", () => {
		expect(moveRight(selecting(["abcd", "ef"], [1, 1], [0, 1]))).toEqual(
			state(["abcd", "ef"], 1, 1),
		);
	});

	it.each([
		["上", moveUp],
		["下", moveDown],
		["行頭", moveToLineStart],
		["行末", moveToLineEnd],
	])("%sへ動くと、選択をやめてカーソルの位置から動く", (_name, motion) => {
		const moved = motion(selecting(["abcd", "efgh", "ijkl"], [0, 0], [1, 2]));

		expect(moved.anchor).toBeUndefined();
		expect(moved.cursor).toEqual(motion(state(["abcd", "efgh", "ijkl"], 1, 2)).cursor);
	});

	it("指定した位置へ動くと、選択をやめる", () => {
		const moved = setCursor(selecting(["abcd"], [0, 0], [0, 2]), { line: 0, column: 3 });

		expect(moved).toEqual(state(["abcd"], 0, 3));
	});
});
