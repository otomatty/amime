import { applyChanges, type Change, type Line, type LineId, startTracking } from "@amime/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deleteBackward, insertText, splitLine } from "./commands.ts";
import {
	applyEdit,
	createHistory as createHistoryFrom,
	type History,
	MAX_HISTORY,
	redo,
	replaceLines,
	undo,
} from "./history.ts";
import type { Command } from "./keymap.ts";
import { moveLeft } from "./motion.ts";
import { selectAll } from "./selection.ts";
import type { EditorState } from "./types.ts";

/** 行IDが t-0, t-1, … の文書から履歴を始める。 */
const createHistory = (initial: EditorState): History =>
	createHistoryFrom(startTracking(initial.lines, "t"), initial.cursor);
const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });
/** 他の人の変更を取り込んだ文書に置き換える。 */
const receive = (history: History, ...changes: Change[]): History =>
	replaceLines(history, applyChanges(history.tracker.lines, changes).lines);
const insertTop = (lineId: string, text: string): Change => ({
	type: "insert",
	line: line(lineId, text),
	after: null,
	before: null,
});

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});
const type =
	(text: string): Command =>
	(current) =>
		insertText(current, text);
/** すべてを選択して、文字で置き換える。 */
const selectAllAndType =
	(text: string): Command =>
	(current) =>
		insertText(selectAll(current), text);
const ungrouped = (at = 0) => ({ group: null, at });
const typing = (at: number) => ({ group: "typing" as const, at });

describe("履歴", () => {
	const initial = state(["ab"], 0, 2);

	it("作った直後は、取り消すものもやり直すものもない", () => {
		const history = createHistory(initial);

		expect(history.present).toEqual(initial);
		expect(history.tracker.lines).toEqual([line("t-0", "ab")]);
		expect(undo(history)).toBe(history);
		expect(redo(history)).toBe(history);
	});

	it("編集を取り消すと、編集の前の状態(カーソルの位置も)に戻る", () => {
		const edited = applyEdit(createHistory(initial), type("c"), ungrouped());
		expect(edited.present).toEqual(state(["abc"], 0, 3));

		expect(undo(edited).present).toEqual(initial);
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
			expect(undo(history).present).toEqual(initial);
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

			expect(undo(history).present).toEqual(initial);
			expect(history.present.lines).toEqual(["abx"]);
		});
	});

	it("取り消すと、選択していた範囲も戻る", () => {
		const selected = applyEdit(createHistory(initial), selectAll, ungrouped());
		const replaced = applyEdit(selected, type("x"), ungrouped());
		expect(replaced.present).toEqual(state(["x"], 0, 1));

		expect(undo(replaced).present).toEqual({
			lines: ["ab"],
			anchor: { line: 0, column: 0 },
			cursor: { line: 0, column: 2 },
		});
	});

	it("消した行を取り消しで戻すと、同じ行IDのまま戻る", () => {
		const start = createHistory(state(["ab", "cd"], 1, 0));
		const joined = applyEdit(start, deleteBackward, ungrouped());
		expect(joined.tracker.lines).toEqual([line("t-0", "abcd")]);

		expect(undo(joined).tracker.lines).toEqual(start.tracker.lines);
	});

	it("行IDと本文は、いつも同じ並びになっている", () => {
		let history = createHistory(state(["ab", "cd"], 0, 2));
		history = applyEdit(history, splitLine, ungrouped());
		history = applyEdit(history, type("x"), ungrouped());

		expect(history.tracker.lines.map((current) => current.text)).toEqual(history.present.lines);
		expect(undo(history).tracker.lines.map((current) => current.text)).toEqual(
			undo(history).present.lines,
		);
	});

	describe("他の人の変更を取り込む(replaceLines)", () => {
		const start = createHistory(state(["題", "本文", "末尾"], 1, 1));

		it("文書を置き換え、カーソルは同じ行についていく", () => {
			const next = receive(start, insertTop("x", "他の人の行"));

			expect(next.present).toEqual(state(["他の人の行", "題", "本文", "末尾"], 2, 1));
			expect(next.tracker.lines[0]).toEqual(line("x", "他の人の行"));
		});

		it("選択している範囲も、同じ行についていく", () => {
			const selecting: History = {
				...start,
				present: {
					...start.present,
					anchor: { line: 1, column: 0 },
					cursor: { line: 2, column: 1 },
				},
			};

			expect(receive(selecting, insertTop("x", "他の人の行")).present).toMatchObject({
				anchor: { line: 2, column: 0 },
				cursor: { line: 3, column: 1 },
			});
		});

		it("選択の始点の行が消されていたら、選択をやめる", () => {
			const selecting: History = {
				...start,
				present: { ...start.present, anchor: { line: 0, column: 0 } },
			};

			const next = receive(selecting, { type: "delete", id: id("t-0") });

			expect(next.present).toEqual(state(["本文", "末尾"], 0, 1));
		});

		it("カーソルのある行が消されていたら、同じ位置にある行へ移る。列は行の長さに収める", () => {
			const next = receive(
				start,
				{ type: "delete", id: id("t-1") },
				{ type: "update", id: id("t-2"), text: "末" },
			);

			expect(next.present).toEqual(state(["題", "末"], 1, 1));
		});

		it("カーソルのあった位置より行が減っていたら、最後の行へ移る", () => {
			const next = receive(
				start,
				{ type: "delete", id: id("t-1") },
				{ type: "delete", id: id("t-2") },
			);

			expect(next.present).toEqual(state(["題"], 0, 1));
		});

		it("すべての行が消されていたら、空の1行を置く(編集欄は常に1行以上を持つ)", () => {
			const next = replaceLines(start, []);

			expect(next.present).toEqual(state([""], 0, 0));
			expect(next.tracker.lines).toEqual([line("t-3", "")]);
		});

		it("取り込んだあとも、自分の編集を取り消せる。他の人の変更は残る", () => {
			const edited = applyEdit(start, type("!"), ungrouped());

			const undone = undo(receive(edited, insertTop("x", "他の人の行")));

			expect(undone.present).toEqual(state(["他の人の行", "題", "本文", "末尾"], 2, 1));
		});

		it("取り消したあとに取り込んでも、やり直せる", () => {
			const undone = undo(applyEdit(start, type("!"), ungrouped()));

			const redone = redo(receive(undone, insertTop("x", "他の人の行")));

			expect(redone.present).toEqual(state(["他の人の行", "題", "本!文", "末尾"], 2, 2));
		});

		it("自分が書き換えた行を他の人がさらに書き換えていたら、その編集は取り消さず、1つ前の編集を取り消す", () => {
			let history = applyEdit(start, splitLine, ungrouped());
			history = applyEdit(history, type("!"), ungrouped());
			expect(history.present.lines).toEqual(["題", "本", "!文", "末尾"]);

			history = receive(history, { type: "update", id: id("t-3"), text: "他の人が書き換えた" });
			const undone = undo(history);

			// 「!」の入力は取り消せない(行が書き換えられている)ので飛ばし、改行を取り消す。
			// 改行で足した行は、他の人が書き換えたので消さない。
			expect(undone.present.lines).toEqual(["題", "本文", "他の人が書き換えた", "末尾"]);
			expect(undo(undone).present.lines).toEqual(undone.present.lines);
		});

		it("取り消せる編集が1つも残っていなければ、文書は変わらない", () => {
			const edited = applyEdit(start, type("!"), ungrouped());
			const overwritten = receive(edited, { type: "update", id: id("t-1"), text: "他の人の本文" });

			const undone = undo(overwritten);

			expect(undone.present).toEqual(overwritten.present);
			expect(undone.tracker).toBe(overwritten.tracker);
			expect(undo(undone)).toBe(undone);
		});

		it("やり直せない編集(他の人が先に書き換えた行)は飛ばす", () => {
			const undone = undo(applyEdit(start, type("!"), ungrouped()));
			const overwritten = receive(undone, { type: "update", id: id("t-1"), text: "他の人の本文" });

			const redone = redo(overwritten);

			expect(redone.present.lines).toEqual(["題", "他の人の本文", "末尾"]);
			expect(redo(redone)).toBe(redone);
		});

		it("取り消しで文書が空になるときは、空の1行を置く", () => {
			const one = createHistory(state(["題"], 0, 1));
			const added = applyEdit(one, splitLine, ungrouped());

			const undone = undo(receive(added, { type: "delete", id: id("t-0") }));

			expect(undone.present).toEqual(state([""], 0, 0));
		});

		it("一部だけ取り消せた編集をやり直しても、取り消さなかった部分(他の人が消した行)は戻さない", () => {
			const one = createHistory(state(["A"], 0, 1));
			const edited = applyEdit(one, type("2\nB"), ungrouped());
			expect(edited.present.lines).toEqual(["A2", "B"]);

			// 他の人が、自分の足した行 B を消した。取り消しで戻るのは、A の書き換えだけ。
			const undone = undo(receive(edited, { type: "delete", id: id("t-1") }));
			expect(undone.present.lines).toEqual(["A"]);

			expect(redo(undone).present.lines).toEqual(["A2"]);
		});

		it("一部だけやり直せた編集を取り消しても、やり直さなかった部分は変えない", () => {
			const two = createHistory(state(["A", "B"], 0, 1));
			const undone = undo(applyEdit(two, selectAllAndType("X"), ungrouped()));
			expect(undone.present.lines).toEqual(["A", "B"]);

			// 他の人が B を書き換えた。やり直しで消えるのは A だけで、B は残る。
			const redone = redo(receive(undone, { type: "update", id: id("t-1"), text: "他の人のB" }));
			expect(redone.present.lines).toEqual(["X", "他の人のB"]);

			expect(undo(redone).present.lines).toEqual(["A", "他の人のB"]);
		});

		it("取り消しで補った空の1行は、やり直すと残らない", () => {
			const one = createHistory(state(["題"], 0, 1));
			const added = applyEdit(one, splitLine, ungrouped());
			const undone = undo(receive(added, { type: "delete", id: id("t-0") }));
			expect(undone.present.lines).toEqual([""]);

			const redone = redo(undone);

			expect(redone.present.lines).toEqual([""]);
			expect(redone.tracker.lines).toEqual([line("t-1", "")]);
		});

		it("取り込みをはさんだ入力は、前の入力とまとめない(他の人の変更を、自分の編集に含めないため)", () => {
			let history = applyEdit(start, type("a"), typing(0));
			history = receive(history, insertTop("x", "他の人の行"));
			history = applyEdit(history, type("b"), typing(100));
			expect(history.present.lines).toEqual(["他の人の行", "題", "本ab文", "末尾"]);

			expect(undo(history).present.lines).toEqual(["他の人の行", "題", "本a文", "末尾"]);
			expect(undo(undo(history)).present.lines).toEqual(["他の人の行", "題", "本文", "末尾"]);
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
