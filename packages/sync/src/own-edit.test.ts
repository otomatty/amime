import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges } from "./changes.ts";
import { reapplyEdit, recordEdit, revertEdit } from "./own-edit.ts";
import type { Change, Line, LineId } from "./types.ts";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string = lineId.toUpperCase()): Line => ({
	id: id(lineId),
	text,
});
const update = (lineId: string, text: string): Change => ({ type: "update", id: id(lineId), text });
/** 他の人の変更を、文書に適用する。 */
const afterRemote = (document: readonly Line[], ...changes: Change[]) =>
	applyChanges(document, changes).lines;

describe("revertEdit(自分の編集を打ち消す)", () => {
	const before = [line("a"), line("b"), line("c")];

	it("書き換えた行を、書き換える前の本文に戻す", () => {
		const after = [line("a"), line("b", "B2"), line("c")];

		expect(revertEdit(after, recordEdit(before, after))).toEqual(before);
	});

	it("足した行を消す", () => {
		const after = [line("a"), line("n"), line("b"), line("c")];

		expect(revertEdit(after, recordEdit(before, after))).toEqual(before);
	});

	it("消した行を、同じ行IDのまま、元の位置に戻す", () => {
		const after = [line("a"), line("c")];

		expect(revertEdit(after, recordEdit(before, after))).toEqual(before);
	});

	it("動かした行を、元の位置に戻す", () => {
		const after = [line("b"), line("c"), line("a")];

		expect(revertEdit(after, recordEdit(before, after))).toEqual(before);
	});

	describe("そのあいだに他の人の変更が入っていたとき", () => {
		const after = [line("a"), line("b", "B2"), line("n"), line("c")];
		const edit = recordEdit(before, after);

		it("他の人が足した行や、書き換えた別の行は、そのまま残る", () => {
			const current = afterRemote(
				after,
				{ type: "insert", line: line("x"), after: null, before: id("a") },
				update("c", "C2"),
			);

			expect(revertEdit(current, edit)).toEqual([line("x"), line("a"), line("b"), line("c", "C2")]);
		});

		it("自分が書き換えた行を他の人がさらに書き換えていたら、その行は戻さない", () => {
			const current = afterRemote(after, update("b", "他の人の本文"));

			expect(revertEdit(current, edit)).toEqual([line("a"), line("b", "他の人の本文"), line("c")]);
		});

		it("自分が足した行を他の人が書き換えていたら、その行は消さない", () => {
			const current = afterRemote(after, update("n", "他の人が書き足した"));

			expect(revertEdit(current, edit)).toEqual([
				line("a"),
				line("b"),
				line("n", "他の人が書き足した"),
				line("c"),
			]);
		});

		it("自分が書き換えた行を他の人が消していたら、その行は戻らない", () => {
			const current = afterRemote(after, { type: "delete", id: id("b") });

			expect(revertEdit(current, edit)).toEqual([line("a"), line("c")]);
		});

		it("消した行を戻すとき、前後の行がなくなっていても、近い位置に戻す", () => {
			const deleted = recordEdit(before, [line("a"), line("c")]);
			const current = afterRemote([line("a"), line("c")], { type: "delete", id: id("a") });

			expect(revertEdit(current, deleted)).toEqual([line("b"), line("c")]);
		});

		it("打ち消せる変更が1つもなければ、同じ文書を返す", () => {
			const current = afterRemote(after, update("b", "他の人の本文"), update("n", "他の人の本文"));

			expect(revertEdit(current, edit)).toBe(current);
		});
	});
});

describe("reapplyEdit(打ち消した編集を、もう一度行う)", () => {
	const before = [line("a"), line("b"), line("c")];
	const after = [line("a", "A2"), line("n"), line("c")];
	const edit = recordEdit(before, after);

	it("打ち消す前の状態に戻る", () => {
		expect(reapplyEdit(revertEdit(after, edit), edit)).toEqual(after);
	});

	it("打ち消したあとに他の人が書き換えた行には、もう一度行わない", () => {
		const reverted = afterRemote(revertEdit(after, edit), update("a", "他の人の本文"));

		expect(reapplyEdit(reverted, edit)).toEqual([line("a", "他の人の本文"), line("n"), line("c")]);
	});

	it("打ち消して戻した行を他の人が書き換えていたら、その行はもう一度消さない", () => {
		const reverted = afterRemote(revertEdit(after, edit), update("b", "他の人の本文"));

		expect(reapplyEdit(reverted, edit)).toEqual([
			line("a", "A2"),
			line("n"),
			line("b", "他の人の本文"),
			line("c"),
		]);
	});
});

describe("自分の編集の記録の性質", () => {
	const document = fc
		.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f"))
		.chain((names) =>
			fc.tuple(
				fc.constant(names),
				fc.array(fc.constantFrom("1", "2"), { minLength: names.length, maxLength: names.length }),
			),
		)
		.map(([names, texts]) => names.map((name, index) => line(name, texts[index])));

	it("どんな編集でも、打ち消すと編集の前に、もう一度行うと編集のあとに戻る", () => {
		fc.assert(
			fc.property(document, document, (before, after) => {
				const edit = recordEdit(before, after);

				expect(revertEdit(after, edit)).toEqual(before);
				expect(reapplyEdit(before, edit)).toEqual(after);
			}),
			{ numRuns: 500 },
		);
	});

	it("打ち消しても、他の人が足した行はなくならない", () => {
		fc.assert(
			fc.property(document, document, fc.nat(), (before, after, seed) => {
				const anchor = after[seed % (after.length + 1)]?.id ?? null;
				const current = afterRemote(after, {
					type: "insert",
					line: line("remote"),
					after: anchor,
					before: null,
				});

				const reverted = revertEdit(current, recordEdit(before, after));

				expect(reverted.map((current) => current.id)).toContain("remote");
				expect(new Set(reverted.map((current) => current.id)).size).toBe(reverted.length);
			}),
			{ numRuns: 300 },
		);
	});
});
