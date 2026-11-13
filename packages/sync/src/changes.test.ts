import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, diffLines } from "./changes.ts";
import { MAX_LINE_LENGTH } from "./schema.ts";
import type { Change, Line, LineId } from "./types.ts";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string = lineId.toUpperCase()): Line => ({
	id: id(lineId),
	text,
});
const ids = (lines: readonly Line[]): string[] => lines.map((current) => current.id);
const insert = (lineId: string, after: string | null, before: string | null): Change => ({
	type: "insert",
	line: line(lineId),
	after: after === null ? null : id(after),
	before: before === null ? null : id(before),
});
const move = (lineId: string, after: string | null, before: string | null): Change => ({
	type: "move",
	id: id(lineId),
	after: after === null ? null : id(after),
	before: before === null ? null : id(before),
});

describe("applyChanges", () => {
	const base = [line("a"), line("b"), line("c")];
	const linesAfter = (...changes: Change[]) => ids(applyChanges(base, changes).lines);

	describe("insert", () => {
		it("after に指定した行の直後に入れる", () => {
			expect(linesAfter(insert("x", "a", "b"))).toEqual(["a", "x", "b", "c"]);
		});

		it("after が null なら先頭に入れる", () => {
			expect(linesAfter(insert("x", null, "a"))).toEqual(["x", "a", "b", "c"]);
		});

		it("before が null でも、after の直後に入れる(末尾への追加)", () => {
			expect(linesAfter(insert("x", "c", null))).toEqual(["a", "b", "c", "x"]);
		});

		it("after の行がなくなっていたら、before の直前に入れる", () => {
			expect(linesAfter(insert("x", "gone", "c"))).toEqual(["a", "b", "x", "c"]);
		});

		it("after と before が離れていたら、after の直後を優先する", () => {
			expect(linesAfter(insert("x", "a", "c"))).toEqual(["a", "x", "b", "c"]);
		});

		it("どちらの行もなくなっていたら、末尾に入れる", () => {
			expect(linesAfter(insert("x", "gone", "gone2"))).toEqual(["a", "b", "c", "x"]);
			expect(linesAfter(insert("x", "gone", null))).toEqual(["a", "b", "c", "x"]);
		});

		it("after が null なら、before がどの行でも(なくなっていても)先頭に入れる", () => {
			expect(linesAfter(insert("x", null, "b"))).toEqual(["x", "a", "b", "c"]);
			expect(linesAfter(insert("x", null, "gone"))).toEqual(["x", "a", "b", "c"]);
		});

		it("同じIDの行が既にあれば、何もしない", () => {
			const duplicate: Change = {
				type: "insert",
				line: line("a", "dup"),
				after: id("c"),
				before: null,
			};

			const result = applyChanges(base, [duplicate]);

			expect(result).toEqual({ lines: base, applied: [] });
		});
	});

	describe("update", () => {
		it("行IDを保ったまま本文を置き換える", () => {
			const result = applyChanges(base, [{ type: "update", id: id("b"), text: "B2" }]);

			expect(result.lines).toEqual([line("a"), line("b", "B2"), line("c")]);
		});

		it("本文が同じなら、何もしない", () => {
			expect(applyChanges(base, [{ type: "update", id: id("b"), text: "B" }]).applied).toEqual([]);
		});

		it("行がなくなっていたら、何もしない(削除が勝つ)", () => {
			const result = applyChanges(base, [{ type: "update", id: id("gone"), text: "?" }]);

			expect(result).toEqual({ lines: base, applied: [] });
		});

		describe("元にした本文(base)つき", () => {
			const lines = [line("a", "今日は晴れ")];
			const update = (text: string, from: string): Change => ({
				type: "update",
				id: id("a"),
				text,
				base: from,
			});

			it("元にした本文のままなら、置き換える", () => {
				const result = applyChanges(lines, [update("今日は雨", "今日は晴れ")]);

				expect(result.lines).toEqual([line("a", "今日は雨")]);
			});

			it("元にした本文から他の人が書き換えていたら、文字単位で統合する", () => {
				const current = [line("a", "今日は晴れです")];

				const result = applyChanges(current, [update("たぶん今日は晴れ", "今日は晴れ")]);

				expect(result.lines).toEqual([line("a", "たぶん今日は晴れです")]);
			});

			it("効いた変更は、統合した結果への置き換えになる(元にした本文は持たない)", () => {
				const current = [line("a", "今日は晴れです")];

				const { applied } = applyChanges(current, [update("たぶん今日は晴れ", "今日は晴れ")]);

				expect(applied).toEqual([{ type: "update", id: id("a"), text: "たぶん今日は晴れです" }]);
				expect(applyChanges(current, applied).lines).toEqual([line("a", "たぶん今日は晴れです")]);
			});

			it("統合しても本文が変わらなければ、何もしない", () => {
				// 消そうとした文字は、他の人がもう消している。
				const current = [line("a", "今日晴れ!")];

				expect(applyChanges(current, [update("今日晴れ", "今日は晴れ")])).toEqual({
					lines: current,
					applied: [],
				});
			});

			it("統合した本文が長さの上限を超えるなら、あとから届いた本文にする", () => {
				const half = MAX_LINE_LENGTH / 2;
				const current = [line("a", `${"あ".repeat(half)}元`)];
				const incoming = `元${"い".repeat(half + 1)}`;

				const result = applyChanges(current, [update(incoming, "元")]);

				expect(result.lines).toEqual([line("a", incoming)]);
			});

			it("1度に統合できる量には上限がある。超えた分は、あとから届いた本文にする", () => {
				const long = "あ".repeat(MAX_LINE_LENGTH - 2);
				const names = Array.from({ length: 80 }, (_, index) => `l${index}`);
				const current = names.map((name) => line(name, `${long}先`));
				const changes = names.map(
					(name): Change => ({ type: "update", id: id(name), text: `後${long}`, base: long }),
				);

				const texts = applyChanges(current, changes).lines.map((merged) => merged.text);

				expect(texts[0]).toBe(`後${long}先`);
				expect(texts.at(-1)).toBe(`後${long}`);
			});

			it("元にした本文がない変更は、あとから届いた本文に置き換える", () => {
				const current = [line("a", "今日は晴れです")];

				const result = applyChanges(current, [
					{ type: "update", id: id("a"), text: "たぶん今日は晴れ" },
				]);

				expect(result.lines).toEqual([line("a", "たぶん今日は晴れ")]);
			});
		});
	});

	describe("delete", () => {
		it("行を取り除く", () => {
			expect(linesAfter({ type: "delete", id: id("b") })).toEqual(["a", "c"]);
		});

		it("行がなくなっていたら、何もしない", () => {
			expect(applyChanges(base, [{ type: "delete", id: id("gone") }]).applied).toEqual([]);
		});
	});

	describe("move", () => {
		it("行IDと本文を保ったまま、after の直後へ移す", () => {
			const result = applyChanges(base, [move("a", "c", null)]);

			expect(result.lines).toEqual([line("b"), line("c"), line("a")]);
		});

		it("先頭へ移す", () => {
			expect(linesAfter(move("c", null, "a"))).toEqual(["c", "a", "b"]);
		});

		it("after の行がなくなっていたら、before の直前へ移す", () => {
			expect(linesAfter(move("a", "gone", "c"))).toEqual(["b", "a", "c"]);
		});

		it("位置が変わらないなら、何もしない", () => {
			expect(applyChanges(base, [move("b", "a", "c")])).toEqual({ lines: base, applied: [] });
		});

		it("動かす行がなくなっていたら、何もしない", () => {
			expect(applyChanges(base, [move("gone", "a", "b")])).toEqual({ lines: base, applied: [] });
		});
	});

	it("複数の変更は順番に適用される", () => {
		expect(
			linesAfter(
				insert("x", "c", null),
				insert("y", "x", null),
				{ type: "delete", id: id("a") },
				move("b", "y", null),
			),
		).toEqual(["c", "x", "y", "b"]);
	});

	it("入力の配列を書き換えない", () => {
		const input = [line("a")];

		applyChanges(input, [{ type: "delete", id: id("a") }]);

		expect(input).toEqual([line("a")]);
	});

	describe("applied(実際に効いた変更)", () => {
		it("何も起きなかった変更を含まない", () => {
			const update: Change = { type: "update", id: id("a"), text: "A2" };

			const { applied } = applyChanges(base, [
				{ type: "delete", id: id("gone") },
				update,
				{ type: "update", id: id("gone"), text: "?" },
			]);

			expect(applied).toEqual([update]);
		});

		it("挿入と移動の位置を、実際に置いた場所の前後の行に書き直す", () => {
			const { applied } = applyChanges(base, [insert("x", "gone", "c"), move("a", "gone", null)]);

			expect(applied).toEqual([insert("x", "b", "c"), move("a", "c", null)]);
		});
	});
});

describe("diffLines", () => {
	it("同じ内容なら変更は空", () => {
		const lines = [line("a")];
		expect(diffLines(lines, lines)).toEqual([]);
	});

	it("本文だけが変わった行は update になる", () => {
		expect(diffLines([line("a")], [line("a", "A2")])).toEqual([
			{ type: "update", id: id("a"), text: "A2", base: "A" },
		]);
	});

	it("増えた行は insert になり、前後の行を位置として持つ", () => {
		expect(diffLines([line("a"), line("b")], [line("a"), line("x"), line("b")])).toEqual([
			insert("x", "a", "b"),
		]);
	});

	it("なくなった行は delete になる", () => {
		expect(diffLines([line("a"), line("b")], [line("b")])).toEqual([
			{ type: "delete", id: id("a") },
		]);
	});

	it("1行を遠くへ動かしても、move は1つだけ(動いていない行には触れない)", () => {
		const before = [line("a"), line("b"), line("c"), line("d")];

		expect(diffLines(before, [line("d"), line("a"), line("b"), line("c")])).toEqual([
			move("d", null, "a"),
		]);
		expect(diffLines(before, [line("b"), line("c"), line("d"), line("a")])).toEqual([
			move("a", "d", null),
		]);
	});

	it("かたまりどうしを入れ替えたときは、行の少ないほうを動かす", () => {
		const before = [line("a"), line("a1"), line("b"), line("b1"), line("b2")];
		const after = [line("b"), line("b1"), line("b2"), line("a"), line("a1")];

		expect(diffLines(before, after)).toEqual([move("a", "b2", "a1"), move("a1", "a", null)]);
	});

	it("動かした行の本文も変わっていれば、move と update の両方になる", () => {
		const before = [line("a"), line("b"), line("c")];

		expect(diffLines(before, [line("b"), line("c"), line("a", "A2")])).toEqual([
			move("a", "c", null),
			{ type: "update", id: id("a"), text: "A2", base: "A" },
		]);
	});
});

/** before から、削除・更新・挿入(と、shuffle が真なら並べ替え)で到達できる after を生成する。 */
const beforeAndAfter = (shuffle: boolean) =>
	fc
		.uniqueArray(fc.integer({ min: 0, max: 999 }), { maxLength: 20 })
		.chain((numbers) =>
			fc.record({
				before: fc.constant(numbers.map((n) => line(`old-${n}`, `text-${n}`))),
				fates: fc.array(fc.constantFrom("keep", "update", "delete"), {
					minLength: numbers.length,
					maxLength: numbers.length,
				}),
				insertsPerGap: fc.array(fc.integer({ min: 0, max: 2 }), {
					minLength: numbers.length + 1,
					maxLength: numbers.length + 1,
				}),
				order: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
					minLength: numbers.length * 3 + 2,
					maxLength: numbers.length * 3 + 2,
				}),
			}),
		)
		.map(({ before, fates, insertsPerGap, order }) => {
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
			if (!shuffle) return { before, after };

			const shuffled = after
				.map((current, index) => ({ current, key: order[index] ?? 0 }))
				.sort((a, b) => a.key - b.key)
				.map(({ current }) => current);
			return { before, after: shuffled };
		});

describe("diffLines と applyChanges の往復", () => {
	it("diffLines(before, after) を before に適用すると、並べ替えがあっても必ず after になる", () => {
		fc.assert(
			fc.property(beforeAndAfter(true), ({ before, after }) => {
				const changes = diffLines(before, after);
				const result = applyChanges(before, changes);

				expect(result.lines).toEqual(after);
				// 差分に、効かない変更は含まれない。
				expect(result.applied).toHaveLength(changes.length);
			}),
			{ numRuns: 500 },
		);
	});

	it("並べ替えがなければ、変わっていない行には触れない", () => {
		fc.assert(
			fc.property(beforeAndAfter(false), ({ before, after }) => {
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

describe("applyChanges の性質", () => {
	const lineId = fc.constantFrom("a", "b", "c", "d", "e", "x", "y").map(id);
	const anchor = fc.option(lineId, { nil: null });
	const change: fc.Arbitrary<Change> = fc.oneof(
		fc.record({
			type: fc.constant("insert" as const),
			line: fc.record({ id: lineId, text: fc.constantFrom("1", "2") }),
			after: anchor,
			before: anchor,
		}),
		fc.record({
			type: fc.constant("update" as const),
			id: lineId,
			text: fc.constantFrom("1", "2", "A1"),
		}),
		fc.record({
			type: fc.constant("update" as const),
			id: lineId,
			text: fc.constantFrom("1", "A2", "2B"),
			base: fc.constantFrom("A", "B", "1"),
		}),
		fc.record({ type: fc.constant("delete" as const), id: lineId }),
		fc.record({ type: fc.constant("move" as const), id: lineId, after: anchor, before: anchor }),
	);
	const document = fc
		.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e"))
		.map((names) => names.map((name) => line(name)));
	const anyChanges = fc.array(change, { maxLength: 12 });

	it("どんな変更の列でも失敗せず、行IDは重複しない", () => {
		fc.assert(
			fc.property(document, anyChanges, (lines, changes) => {
				const result = applyChanges(lines, changes);

				expect(new Set(ids(result.lines)).size).toBe(result.lines.length);
			}),
			{ numRuns: 500 },
		);
	});

	it("applied を同じ文書に適用すると、同じ結果になり、すべての変更が書き直されずにそのまま効く", () => {
		fc.assert(
			fc.property(document, anyChanges, (lines, changes) => {
				const first = applyChanges(lines, changes);
				const second = applyChanges(lines, first.applied);

				expect(second.lines).toEqual(first.lines);
				expect(second.applied).toEqual(first.applied);
			}),
			{ numRuns: 500 },
		);
	});
});
