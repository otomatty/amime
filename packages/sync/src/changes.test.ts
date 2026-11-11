import { err, ok } from "@amime/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, diffLines } from "./changes.ts";
import type { Line, LineId } from "./types.ts";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });

describe("applyChanges", () => {
	const base = [line("a", "A"), line("b", "B")];

	it("insert は指定した行の直前に挿入する", () => {
		const result = applyChanges(base, [{ type: "insert", before: id("b"), line: line("x", "X") }]);
		expect(result).toEqual(ok([line("a", "A"), line("x", "X"), line("b", "B")]));
	});

	it("insert で before が null なら末尾に追加する", () => {
		const result = applyChanges(base, [{ type: "insert", before: null, line: line("x", "X") }]);
		expect(result).toEqual(ok([...base, line("x", "X")]));
	});

	it("update は行IDを保ったまま本文を置き換える", () => {
		const result = applyChanges(base, [{ type: "update", id: id("a"), text: "A2" }]);
		expect(result).toEqual(ok([line("a", "A2"), line("b", "B")]));
	});

	it("delete は行を取り除く", () => {
		const result = applyChanges(base, [{ type: "delete", id: id("a") }]);
		expect(result).toEqual(ok([line("b", "B")]));
	});

	it("複数の変更は順番に適用される", () => {
		const result = applyChanges(base, [
			{ type: "insert", before: null, line: line("x", "X") },
			{ type: "insert", before: id("x"), line: line("y", "Y") },
			{ type: "delete", id: id("a") },
		]);
		expect(result).toEqual(ok([line("b", "B"), line("y", "Y"), line("x", "X")]));
	});

	it.each([
		["insert の挿入位置", { type: "insert", before: id("zz"), line: line("x", "X") }],
		["update の対象", { type: "update", id: id("zz"), text: "?" }],
		["delete の対象", { type: "delete", id: id("zz") }],
	] as const)("%sが存在しなければ line-not-found を返す", (_name, change) => {
		expect(applyChanges(base, [change])).toEqual(err({ kind: "line-not-found", id: id("zz") }));
	});

	it("既に存在する行IDの insert は duplicate-line を返す", () => {
		const result = applyChanges(base, [{ type: "insert", before: null, line: line("a", "dup") }]);
		expect(result).toEqual(err({ kind: "duplicate-line", id: id("a") }));
	});

	it("失敗しても入力の配列を書き換えない", () => {
		const input = [line("a", "A")];
		applyChanges(input, [
			{ type: "delete", id: id("a") },
			{ type: "delete", id: id("zz") },
		]);
		expect(input).toEqual([line("a", "A")]);
	});
});

describe("diffLines", () => {
	it("同じ内容なら変更は空", () => {
		const lines = [line("a", "A")];
		expect(diffLines(lines, lines)).toEqual([]);
	});

	it("本文だけが変わった行は update になる", () => {
		expect(diffLines([line("a", "A")], [line("a", "A2")])).toEqual([
			{ type: "update", id: id("a"), text: "A2" },
		]);
	});
});

/**
 * before から「削除・更新・新規行の挿入」だけで到達できる after を生成する。
 * 生き残った行の相対順序は変わらない(行の移動は「削除+新IDで挿入」として表す)。
 */
const beforeAndAfter = fc
	.uniqueArray(fc.integer({ min: 0, max: 999 }), { maxLength: 20 })
	.chain((ids) =>
		fc.record({
			before: fc.constant(ids.map((n) => line(`old-${n}`, `text-${n}`))),
			fates: fc.array(fc.constantFrom("keep", "update", "delete"), {
				minLength: ids.length,
				maxLength: ids.length,
			}),
			insertsPerGap: fc.array(fc.integer({ min: 0, max: 2 }), {
				minLength: ids.length + 1,
				maxLength: ids.length + 1,
			}),
		}),
	)
	.map(({ before, fates, insertsPerGap }) => {
		let serial = 0;
		const fresh = (count: number): Line[] =>
			Array.from({ length: count }, () => {
				serial += 1;
				return line(`new-${serial}`, `inserted-${serial}`);
			});

		const after: Line[] = [];
		before.forEach((current, index) => {
			after.push(...fresh(insertsPerGap[index] ?? 0));
			const fate = fates[index];
			if (fate === "keep") after.push(current);
			if (fate === "update") after.push({ ...current, text: `${current.text}!` });
		});
		after.push(...fresh(insertsPerGap[before.length] ?? 0));
		return { before, after };
	});

describe("diffLines と applyChanges の往復", () => {
	it("diffLines(before, after) を before に適用すると必ず after になる", () => {
		fc.assert(
			fc.property(beforeAndAfter, ({ before, after }) => {
				expect(applyChanges(before, diffLines(before, after))).toEqual(ok(after));
			}),
		);
	});

	it("差分は必要最小限(変わっていない行には触れない)", () => {
		fc.assert(
			fc.property(beforeAndAfter, ({ before, after }) => {
				const unchanged = new Set(
					before
						.filter((b) => after.some((a) => a.id === b.id && a.text === b.text))
						.map((b) => b.id),
				);
				for (const change of diffLines(before, after)) {
					const touched = change.type === "insert" ? change.line.id : change.id;
					expect(unchanged.has(touched)).toBe(false);
				}
			}),
		);
	});
});
