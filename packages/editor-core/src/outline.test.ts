import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	indentBlock,
	moveBlockDown,
	moveBlockUp,
	moveLinesDown,
	moveLinesUp,
	outdentBlock,
} from "./outline.ts";
import type { EditorState } from "./types.ts";

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});
const selecting = (
	lines: string[],
	anchor: [number, number],
	cursor: [number, number],
): EditorState => ({
	lines,
	anchor: { line: anchor[0], column: anchor[1] },
	cursor: { line: cursor[0], column: cursor[1] },
});

describe("moveLinesUp / moveLinesDown: 行だけを動かす", () => {
	it("カーソルのある行を、1つ上の行と入れ替える。カーソルは行についていく", () => {
		expect(moveLinesUp(state(["a", "b", "c"], 1, 1))).toEqual(state(["b", "a", "c"], 0, 1));
	});

	it("カーソルのある行を、1つ下の行と入れ替える", () => {
		expect(moveLinesDown(state(["a", "b", "c"], 1, 1))).toEqual(state(["a", "c", "b"], 2, 1));
	});

	it("子の行は一緒に動かさない", () => {
		expect(moveLinesDown(state(["a", " a1", "b"], 0, 0))).toEqual(state([" a1", "a", "b"], 1, 0));
	});

	it("最初の行は上へ、最後の行は下へ動かせない", () => {
		const top = state(["a", "b"], 0, 0);
		const bottom = state(["a", "b"], 1, 0);

		expect(moveLinesUp(top)).toBe(top);
		expect(moveLinesDown(bottom)).toBe(bottom);
	});

	it("選択しているときは、選択にかかるすべての行を動かし、選択を保つ", () => {
		expect(moveLinesUp(selecting(["a", "bc", "de", "f"], [1, 1], [2, 1]))).toEqual(
			selecting(["bc", "de", "a", "f"], [0, 1], [1, 1]),
		);
		expect(moveLinesDown(selecting(["a", "bc", "de", "f"], [2, 1], [1, 1]))).toEqual(
			selecting(["a", "f", "bc", "de"], [3, 1], [2, 1]),
		);
	});

	it("行頭で終わる選択の行を文書の末尾へ動かすと、選択の終わりは末尾に置く(直後の行がなくなるため)", () => {
		expect(moveLinesDown(selecting(["a", "b"], [0, 0], [1, 0]))).toEqual(
			selecting(["b", "a"], [1, 0], [1, 1]),
		);
	});

	it("選択が行頭で終わっているとき、その行は動かさない。選択の終わりは、動かした行の直後についていく", () => {
		expect(moveLinesDown(selecting(["a", "b", "c", "d"], [0, 0], [2, 0]))).toEqual(
			selecting(["c", "a", "b", "d"], [1, 0], [3, 0]),
		);
	});
});

describe("moveBlockUp / moveBlockDown: 子の行ごと動かす", () => {
	const outline = ["A", " a1", "B", " b1", "  b2", "C"];

	it("行を子の行ごと、上にある同じ深さのかたまりと入れ替える", () => {
		expect(moveBlockUp(state(outline, 2, 1))).toEqual(
			state(["B", " b1", "  b2", "A", " a1", "C"], 0, 1),
		);
	});

	it("行を子の行ごと、下にある同じ深さのかたまりと入れ替える", () => {
		expect(moveBlockDown(state(outline, 0, 0))).toEqual(
			state(["B", " b1", "  b2", "A", " a1", "C"], 3, 0),
		);
	});

	it("子の行の途中にカーソルがあれば、その行と、それより深い行だけが動く", () => {
		expect(moveBlockUp(state(["A", " a1", " a2", "  x"], 2, 0))).toEqual(
			state(["A", " a2", "  x", " a1"], 1, 0),
		);
	});

	it("最初の子を上へ動かすと、親の行の上に出る", () => {
		expect(moveBlockUp(state(["P", " c1", " c2"], 1, 0))).toEqual(state([" c1", "P", " c2"], 0, 0));
	});

	it("最後の子を下へ動かすと、次の浅い行の下に出る", () => {
		expect(moveBlockDown(state(["A", " a1", "B"], 1, 0))).toEqual(state(["A", "B", " a1"], 2, 0));
	});

	it("すぐ上に、同じ深さの行を持たない深い行の並びがあれば、その並びと入れ替える", () => {
		expect(moveBlockUp(state(["P", "   deep", " c"], 2, 0))).toEqual(
			state(["P", " c", "   deep"], 1, 0),
		);
	});

	it("文書の先頭のかたまりは上へ、末尾のかたまりは下へ動かせない", () => {
		const top = state(["A", " a1", "B"], 0, 0);
		const bottom = state(["A", "B", " b1"], 1, 0);

		expect(moveBlockUp(top)).toBe(top);
		expect(moveBlockDown(bottom)).toBe(bottom);
	});

	it("選択しているときは、選択にかかる行とその子の行を、まとめて動かす", () => {
		expect(moveBlockDown(selecting(outline, [0, 0], [2, 1]))).toEqual(
			selecting(["C", "A", " a1", "B", " b1", "  b2"], [1, 0], [3, 1]),
		);
	});

	it("コードブロックは、始まりの行にカーソルがあれば中身ごと動く", () => {
		expect(moveBlockDown(state(["code:a.js", " x", " y", "z"], 0, 0))).toEqual(
			state(["z", "code:a.js", " x", " y"], 1, 0),
		);
	});
});

describe("indentBlock / outdentBlock: 子の行ごとインデントを変える", () => {
	it("行とその子の行を、まとめて1段深くする", () => {
		expect(indentBlock(state(["A", " a1", "  a2", "B"], 0, 1))).toEqual(
			state([" A", "  a1", "   a2", "B"], 0, 2),
		);
	});

	it("行とその子の行を、まとめて1段浅くする", () => {
		expect(outdentBlock(state(["P", " A", "  a1", " B"], 1, 2))).toEqual(
			state(["P", "A", " a1", " B"], 1, 1),
		);
	});

	it("いちばん浅い行にインデントがなければ、浅くしない(子の行だけが親と同じ深さになるのを避ける)", () => {
		const before = state(["A", " a1"], 0, 0);
		expect(outdentBlock(before)).toBe(before);
	});

	it("選択しているときは、選択にかかる行とその子の行が対象になる", () => {
		expect(indentBlock(selecting(["A", " a1", "B", " b1", "C"], [0, 0], [2, 1]))).toEqual(
			selecting([" A", "  a1", " B", "  b1", "C"], [0, 1], [2, 2]),
		);
	});
});

describe("行やかたまりを動かす操作の性質", () => {
	const line = fc
		.tuple(fc.integer({ min: 0, max: 3 }), fc.constantFrom("a", "b", "c", "d", ""))
		.map(([indent, text]) => " ".repeat(indent) + text);
	const document = fc.array(line, { minLength: 1, maxLength: 8 }).chain((lines) =>
		fc.record({
			lines: fc.constant(lines),
			cursor: fc
				.integer({ min: 0, max: lines.length - 1 })
				.map((index) => ({ line: index, column: 0 })),
		}),
	);

	it.each([
		["moveLinesUp", moveLinesUp],
		["moveLinesDown", moveLinesDown],
		["moveBlockUp", moveBlockUp],
		["moveBlockDown", moveBlockDown],
	])(
		"%s: 行を増やしも減らしもせず並べ替えるだけで、カーソルは同じ行についていく",
		(_name, move) => {
			fc.assert(
				fc.property(document, (before) => {
					const after = move(before);

					expect([...after.lines].sort()).toEqual([...before.lines].sort());
					expect(after.lines[after.cursor.line]).toBe(before.lines[before.cursor.line]);
				}),
				{ numRuns: 300 },
			);
		},
	);

	it("moveLinesUp のあとに moveLinesDown を行うと、元に戻る", () => {
		fc.assert(
			fc.property(document, (before) => {
				const up = moveLinesUp(before);
				fc.pre(up !== before);

				expect(moveLinesDown(up)).toEqual(before);
			}),
		);
	});

	it("indentBlock のあとに outdentBlock を行うと、元に戻る", () => {
		fc.assert(
			fc.property(document, (before) => {
				expect(outdentBlock(indentBlock(before)).lines).toEqual(before.lines);
			}),
		);
	});
});
