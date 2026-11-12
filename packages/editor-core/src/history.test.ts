import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deleteBackward, insertText, splitLine } from "./commands.ts";
import { applyEdit, createHistory, MAX_HISTORY, redo, undo } from "./history.ts";
import type { Command } from "./keymap.ts";
import { moveLeft } from "./motion.ts";
import type { EditorState } from "./types.ts";

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});
const type =
	(text: string): Command =>
	(current) =>
		insertText(current, text);
const ungrouped = (at = 0) => ({ group: null, at });
const typing = (at: number) => ({ group: "typing" as const, at });

describe("履歴", () => {
	const initial = state(["ab"], 0, 2);

	it("作った直後は、取り消すものもやり直すものもない", () => {
		const history = createHistory(initial);

		expect(history.present).toBe(initial);
		expect(undo(history)).toBe(history);
		expect(redo(history)).toBe(history);
	});

	it("編集を取り消すと、編集の前の状態(カーソルの位置も)に戻る", () => {
		const edited = applyEdit(createHistory(initial), type("c"), ungrouped());
		expect(edited.present).toEqual(state(["abc"], 0, 3));

		expect(undo(edited).present).toBe(initial);
	});

	it("取り消した編集は、やり直せる", () => {
		const edited = applyEdit(createHistory(initial), type("c"), ungrouped());

		expect(redo(undo(edited)).present).toEqual(state(["abc"], 0, 3));
	});

	it("取り消したあとに新しい編集をすると、やり直しはできなくなる", () => {
		const undone = undo(applyEdit(createHistory(initial), type("c"), ungrouped()));

		const edited = applyEdit(undone, type("x"), ungrouped());

		expect(edited.present.lines).toEqual(["abx"]);
		expect(redo(edited)).toBe(edited);
	});

	it("カーソルの移動は履歴に積まない(取り消しの対象は文書の変更だけ)", () => {
		const moved = applyEdit(createHistory(initial), moveLeft, ungrouped());

		expect(moved.present.cursor).toEqual({ line: 0, column: 1 });
		expect(undo(moved)).toBe(moved);
	});

	it("何も変えない操作では、履歴も変わらない", () => {
		const history = createHistory(state(["ab"], 0, 0));

		expect(applyEdit(history, deleteBackward, ungrouped())).toBe(history);
	});

	describe("編集をまとめる", () => {
		it("続けて打った文字は、1回の取り消しでまとめて消える", () => {
			let history = createHistory(initial);
			history = applyEdit(history, type("c"), typing(0));
			history = applyEdit(history, type("d"), typing(300));
			history = applyEdit(history, type("e"), typing(600));

			expect(history.present.lines).toEqual(["abcde"]);
			expect(undo(history).present).toBe(initial);
		});

		it("間が空いたら、別の取り消しの単位になる", () => {
			let history = createHistory(initial);
			history = applyEdit(history, type("c"), typing(0));
			history = applyEdit(history, type("d"), typing(5000));

			expect(undo(history).present.lines).toEqual(["abc"]);
		});

		it("種類の違う編集は、まとめない", () => {
			let history = createHistory(initial);
			history = applyEdit(history, type("c"), typing(0));
			history = applyEdit(history, deleteBackward, { group: "delete-backward", at: 100 });

			expect(history.present.lines).toEqual(["ab"]);
			expect(undo(history).present.lines).toEqual(["abc"]);
		});

		it("まとまりを指定しない編集(改行や貼り付け)は、必ず単独の単位になる", () => {
			let history = createHistory(initial);
			history = applyEdit(history, type("c"), typing(0));
			history = applyEdit(history, splitLine, ungrouped(100));
			history = applyEdit(history, type("d"), typing(200));

			expect(undo(history).present.lines).toEqual(["abc", ""]);
			expect(undo(undo(history)).present.lines).toEqual(["abc"]);
		});

		it("あいだにカーソルを動かしたら、まとめない", () => {
			let history = createHistory(initial);
			history = applyEdit(history, type("c"), typing(0));
			history = applyEdit(history, moveLeft, ungrouped(100));
			history = applyEdit(history, type("d"), typing(200));

			expect(history.present.lines).toEqual(["abdc"]);
			expect(undo(history).present.lines).toEqual(["abc"]);
		});

		it("取り消したあとの編集は、取り消す前の編集とまとめない", () => {
			let history = createHistory(initial);
			history = applyEdit(history, type("c"), typing(0));
			history = applyEdit(history, type("d"), typing(100));
			history = undo(history);
			history = applyEdit(history, type("x"), typing(200));

			expect(undo(history).present).toBe(initial);
			expect(history.present.lines).toEqual(["abx"]);
		});
	});

	it("覚えておく履歴の数には上限があり、古いものから捨てる", () => {
		let history = createHistory(state([""], 0, 0));
		for (let count = 0; count < MAX_HISTORY + 10; count += 1) {
			history = applyEdit(history, type("a"), ungrouped());
		}

		expect(history.past).toHaveLength(MAX_HISTORY);
		let oldest = history;
		for (let count = 0; count < MAX_HISTORY + 10; count += 1) oldest = undo(oldest);
		expect(oldest.present.lines).toEqual(["a".repeat(10)]);
	});

	it("どんな編集の列でも、すべて取り消せば最初に、すべてやり直せば最後の状態に戻る", () => {
		const edits = fc.array(
			fc.oneof(
				fc.constantFrom("a", "b", "あ", "x\ny").map(type),
				fc.constantFrom<Command>(deleteBackward, splitLine, moveLeft),
			),
			{ maxLength: 30 },
		);

		fc.assert(
			fc.property(edits, (commands) => {
				const start = createHistory(state(["ab", "cd"], 1, 1));
				const end = commands.reduce(
					(history, command) => applyEdit(history, command, ungrouped()),
					start,
				);

				let undone = end;
				for (let count = 0; count < commands.length; count += 1) undone = undo(undone);
				expect(undone.present.lines).toEqual(start.present.lines);

				let redone = undone;
				for (let count = 0; count < commands.length; count += 1) redone = redo(redone);
				expect(redone.present.lines).toEqual(end.present.lines);
			}),
		);
	});
});
