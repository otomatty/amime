import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assignLineIds, startTracking, trackLines } from "./line-ids.ts";
import type { Line, LineId } from "./types.ts";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });

/** n1, n2, … の順に新しいIDを作る。 */
function counter(): () => LineId {
	let serial = 0;
	return () => {
		serial += 1;
		return id(`n${serial}`);
	};
}

const assign = (previous: readonly Line[], texts: readonly string[]) =>
	assignLineIds(previous, texts, counter());

describe("assignLineIds", () => {
	const previous = [line("t", "題"), line("a", "abc"), line("b", "def")];

	it("本文が変わっていなければ、同じ配列を返す", () => {
		expect(assign(previous, ["題", "abc", "def"])).toBe(previous);
	});

	it("行の中で文字を打っても、その行のIDは変わらない", () => {
		expect(assign(previous, ["題", "abcd", "def"])).toEqual([
			line("t", "題"),
			line("a", "abcd"),
			line("b", "def"),
		]);
	});

	it("行末で改行すると、新しい行にだけ新しいIDが付く", () => {
		expect(assign(previous, ["題", "abc", "", "def"])).toEqual([
			line("t", "題"),
			line("a", "abc"),
			line("n1", ""),
			line("b", "def"),
		]);
	});

	it("行頭で改行すると、本文のある行がIDを保ち、上にできた空行に新しいIDが付く", () => {
		expect(assign(previous, ["題", "", "abc", "def"])).toEqual([
			line("t", "題"),
			line("n1", ""),
			line("a", "abc"),
			line("b", "def"),
		]);
	});

	it("行の途中で改行すると、前半が元のIDを保つ", () => {
		expect(assign(previous, ["題", "a", "bc", "def"])).toEqual([
			line("t", "題"),
			line("a", "a"),
			line("n1", "bc"),
			line("b", "def"),
		]);
	});

	it("2つの行をつなげると、上の行のIDが残る", () => {
		expect(assign(previous, ["題", "abcdef"])).toEqual([line("t", "題"), line("a", "abcdef")]);
	});

	it("行を消すと、残った行のIDは変わらない", () => {
		expect(assign(previous, ["題", "def"])).toEqual([line("t", "題"), line("b", "def")]);
	});

	it("行を並べ替えると、IDは本文についていく", () => {
		const outline = [line("a", "A"), line("a1", " a1"), line("b", "B"), line("b1", " b1")];

		expect(assign(outline, ["B", " b1", "A", " a1"])).toEqual([
			line("b", "B"),
			line("b1", " b1"),
			line("a", "A"),
			line("a1", " a1"),
		]);
	});

	it("複数の行の本文が同時に変わったら(まとめてインデントなど)、上から順に対応させる", () => {
		expect(assign(previous, ["題", " abc", " def"])).toEqual([
			line("t", "題"),
			line("a", " abc"),
			line("b", " def"),
		]);
	});

	it("同じ本文の行が複数あっても、1つのIDは1度しか使わない", () => {
		const same = [line("a", "x"), line("b", "y"), line("c", "x")];

		expect(assign(same, ["x", "x", "x", "y"]).map((current) => current.id)).toEqual([
			"a",
			"c",
			"n1",
			"b",
		]);
	});

	it("すべての行が置き換わったら、上から順に元のIDを引き継ぎ、足りない分に新しいIDを付ける", () => {
		expect(assign([line("a", "1"), line("b", "2")], ["x", "y", "z"])).toEqual([
			line("a", "x"),
			line("b", "y"),
			line("n1", "z"),
		]);
	});

	it("どんな編集でも、本文は渡したとおりになり、IDは重複しない", () => {
		const text = fc.constantFrom("", "a", "b", " a", "c");
		const document = fc
			.array(text, { maxLength: 8 })
			.map((texts) => texts.map((current, index) => line(`old${index}`, current)));

		fc.assert(
			fc.property(document, fc.array(text, { maxLength: 8 }), (before, texts) => {
				const after = assign(before, texts);

				expect(after.map((current) => current.text)).toEqual(texts);
				expect(new Set(after.map((current) => current.id)).size).toBe(after.length);
			}),
			{ numRuns: 500 },
		);
	});
});

describe("startTracking / trackLines", () => {
	it("最初の行に、接頭辞と連番からなるIDを付ける", () => {
		expect(startTracking(["題", "本文"], "c1")).toEqual({
			lines: [line("c1-0", "題"), line("c1-1", "本文")],
			prefix: "c1",
			serial: 2,
		});
	});

	it("編集後の本文にIDを割り当て、新しい行には続きの連番を使う", () => {
		const tracker = startTracking(["題", "本文"], "c1");

		const next = trackLines(tracker, ["題", "本文", "追記"]);

		expect(next.lines).toEqual([line("c1-0", "題"), line("c1-1", "本文"), line("c1-2", "追記")]);
		expect(next.serial).toBe(3);
	});

	it("連番は36進数で、消した行の番号は使い回さない", () => {
		const texts = Array.from({ length: 36 }, (_, index) => `${index}`);
		const tracker = trackLines(startTracking(texts, "c"), ["0"]);

		expect(trackLines(tracker, ["0", "new"]).lines.at(-1)).toEqual(line("c-10", "new"));
	});

	it("本文が変わっていなければ、同じものを返す", () => {
		const tracker = startTracking(["題"], "c1");

		expect(trackLines(tracker, ["題"])).toBe(tracker);
	});
});
