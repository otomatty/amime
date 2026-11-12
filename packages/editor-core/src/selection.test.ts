import { InvariantError } from "@amime/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deleteSelection } from "./commands.ts";
import { moveLeft, moveRight } from "./motion.ts";
import { extendSelection, selectAll, selectedText, selectTo } from "./selection.ts";
import { selectionRange } from "./state.ts";
import type { Cursor, EditorState } from "./types.ts";

const at = (line: number, column: number): Cursor => ({ line, column });
const selecting = (lines: string[], anchor: Cursor, cursor: Cursor): EditorState => ({
	lines,
	cursor,
	anchor,
});
const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: at(line, column),
});

describe("selectionRange", () => {
	it("選択していなければ null", () => {
		expect(selectionRange(state(["abc"], 0, 1))).toBeNull();
	});

	it("始点とカーソルが同じ位置なら、選択していないのと同じ", () => {
		expect(selectionRange(selecting(["abc"], at(0, 1), at(0, 1)))).toBeNull();
	});

	it("始点とカーソルを、文書の前後の順に並べて返す", () => {
		const forward = selecting(["abc", "def"], at(0, 1), at(1, 2));
		const backward = selecting(["abc", "def"], at(1, 2), at(0, 1));

		expect(selectionRange(forward)).toEqual({ start: at(0, 1), end: at(1, 2) });
		expect(selectionRange(backward)).toEqual({ start: at(0, 1), end: at(1, 2) });
	});

	it("同じ行の中では、文字位置で前後を決める", () => {
		expect(selectionRange(selecting(["abc"], at(0, 2), at(0, 0)))).toEqual({
			start: at(0, 0),
			end: at(0, 2),
		});
	});
});

describe("selectedText", () => {
	it("選択していなければ空文字列", () => {
		expect(selectedText(state(["abc"], 0, 1))).toBe("");
	});

	it("1行の中の選択は、その部分の文字列", () => {
		expect(selectedText(selecting(["abcd"], at(0, 1), at(0, 3)))).toBe("bc");
	});

	it("複数行の選択は、行を改行でつないだ文字列(記法やインデントもそのまま)", () => {
		const selection = selecting(["ab", " [c]", "de"], at(0, 1), at(2, 1));

		expect(selectedText(selection)).toBe("b\n [c]\nd");
	});

	it("行末から次の行の頭までの選択は、改行1つ", () => {
		expect(selectedText(selecting(["ab", "cd"], at(0, 2), at(1, 0)))).toBe("\n");
	});

	it("選択の端が行の範囲外なら不変条件違反", () => {
		expect(() => selectedText(selecting(["ab"], at(0, 0), at(3, 0)))).toThrow(InvariantError);
	});
});

describe("deleteSelection", () => {
	it("選択していなければ何も変えない", () => {
		const before = state(["abc"], 0, 1);
		expect(deleteSelection(before)).toBe(before);
	});

	it("1行の中の選択を消し、カーソルを選択の始まりに置く", () => {
		expect(deleteSelection(selecting(["abcd"], at(0, 3), at(0, 1)))).toEqual(state(["ad"], 0, 1));
	});

	it("複数行の選択を消すと、前後の行がつながる", () => {
		expect(deleteSelection(selecting(["ab", "cd", "ef", "gh"], at(0, 1), at(2, 1)))).toEqual(
			state(["af", "gh"], 0, 1),
		);
	});

	it("消したあとは選択していない状態になる", () => {
		expect(deleteSelection(selecting(["abcd"], at(0, 1), at(0, 3))).anchor).toBeUndefined();
	});

	it("消した結果、両側の文字が1文字に結合したら、カーソルはその文字の手前に置く", () => {
		const J = "\u{1F1EF}";
		const P = "\u{1F1F5}";
		expect(deleteSelection(selecting([`a${J}x${P}`], at(0, 3), at(0, 4)))).toEqual(
			state([`a${J}${P}`], 0, 1),
		);
	});
});

describe("extendSelection", () => {
	it("選択していないときは、いまのカーソル位置を始点にして、移動した先まで選択する", () => {
		expect(extendSelection(moveRight)(state(["abc"], 0, 1))).toEqual(
			selecting(["abc"], at(0, 1), at(0, 2)),
		);
	});

	it("選択しているときは、始点を保ったままカーソルだけを動かす", () => {
		const before = selecting(["abc"], at(0, 0), at(0, 2));

		expect(extendSelection(moveLeft)(before)).toEqual(selecting(["abc"], at(0, 0), at(0, 1)));
	});

	it("カーソルが始点まで戻ったら、選択していない状態になる", () => {
		const before = selecting(["abc"], at(0, 1), at(0, 2));

		expect(extendSelection(moveLeft)(before)).toEqual(state(["abc"], 0, 1));
	});

	it("動けなかったときは、状態を変えない", () => {
		const before = state(["abc"], 0, 0);
		expect(extendSelection(moveLeft)(before)).toBe(before);
	});
});

describe("selectTo", () => {
	it("いまのカーソル位置から、指定した位置までを選択する", () => {
		expect(selectTo(state(["abc", "def"], 0, 1), at(1, 2))).toEqual(
			selecting(["abc", "def"], at(0, 1), at(1, 2)),
		);
	});

	it("すでに選択しているときは、始点を保つ", () => {
		const before = selecting(["abc", "def"], at(0, 1), at(1, 2));

		expect(selectTo(before, at(0, 3))).toEqual(selecting(["abc", "def"], at(0, 1), at(0, 3)));
	});

	it("範囲外や文字の途中の指定は、有効な位置に寄せる", () => {
		expect(selectTo(state(["a👍"], 0, 0), at(9, 2)).cursor).toEqual(at(0, 1));
	});

	it("位置が変わらなければ、同じ状態を返す(ドラッグ中の無駄な再描画を避ける)", () => {
		const before = selecting(["abc"], at(0, 0), at(0, 2));
		expect(selectTo(before, at(0, 2))).toBe(before);
	});
});

describe("selectAll", () => {
	it("文書の先頭から末尾までを選択し、カーソルを末尾に置く", () => {
		expect(selectAll(state(["ab", "cde"], 0, 1))).toEqual(
			selecting(["ab", "cde"], at(0, 0), at(1, 3)),
		);
	});

	it("空の文書では、選択していない状態になる", () => {
		expect(selectAll(state([""], 0, 0))).toEqual(state([""], 0, 0));
	});
});

describe("選択の性質", () => {
	/** 英数字だけの行と、その中の2つの位置。 */
	const selection = fc
		.array(fc.string({ unit: fc.constantFrom("a", "b", " ", "["), maxLength: 6 }), {
			minLength: 1,
			maxLength: 6,
		})
		.chain((lines) => {
			const position = fc.integer({ min: 0, max: lines.length - 1 }).chain((line) =>
				fc.record({
					line: fc.constant(line),
					column: fc.integer({ min: 0, max: (lines[line] ?? "").length }),
				}),
			);
			return fc.record({ lines: fc.constant(lines), anchor: position, cursor: position });
		});

	/** 文書全体を1つの文字列とみたときの、位置の番号。 */
	const offsetOf = (lines: readonly string[], cursor: Cursor): number =>
		lines.slice(0, cursor.line).reduce((sum, text) => sum + text.length + 1, 0) + cursor.column;

	it("選択した文字列と、消したあとの文書をつなぐと、元の文書になる", () => {
		fc.assert(
			fc.property(selection, (before) => {
				const whole = before.lines.join("\n");
				const from = Math.min(
					offsetOf(before.lines, before.anchor),
					offsetOf(before.lines, before.cursor),
				);
				const to = Math.max(
					offsetOf(before.lines, before.anchor),
					offsetOf(before.lines, before.cursor),
				);

				expect(selectedText(before)).toBe(whole.slice(from, to));
				const after = deleteSelection(before);
				expect(after.lines.join("\n")).toBe(whole.slice(0, from) + whole.slice(to));
				expect(offsetOf(after.lines, after.cursor)).toBe(from);
			}),
			{ numRuns: 500 },
		);
	});
});
