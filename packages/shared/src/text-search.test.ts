import { describe, expect, it } from "vitest";
import { foldText, highlight, matchingLines, SNIPPET_LENGTH, textTerms } from "./text-search.ts";

describe("foldText(照らし合わせるための形にする)", () => {
	it("大文字と小文字、全角と半角の違いをなくす", () => {
		expect(foldText("Ｍｉｌｋ ＴＥＡ ｶﾞｲﾄﾞ １２３")).toBe("milk tea ガイド 123");
	});
});

describe("textTerms(本文を探すための語)", () => {
	it("空白で区切り、照らし合わせるための形にする", () => {
		expect(textTerms("  牛乳　Ｍｉｌｋ tea ")).toEqual(["牛乳", "milk", "tea"]);
	});

	it("何も入っていなければ、語はない", () => {
		expect(textTerms(" 　 ")).toEqual([]);
	});

	it("語の数や長さで、入力を切り捨てない。同じ語は、1つにまとめる", () => {
		const long = "あ".repeat(80);

		expect(textTerms(`${long} b c d e f g B ｂ`)).toEqual([long, "b", "c", "d", "e", "f", "g"]);
	});
});

describe("matchingLines(語を含む行を取り出す)", () => {
	const lines = ["牛乳を買う", "関係ない行", "Milk Tea を作る", "牛乳と卵", "もう1つの牛乳"];

	it("どれかの語を含む行を、出てくる順に、上限まで取り出す", () => {
		expect(matchingLines(lines, textTerms("牛乳 tea"), 3)).toEqual([
			"牛乳を買う",
			"Milk Tea を作る",
			"牛乳と卵",
		]);
	});

	it("全角と半角、大文字と小文字の違いは区別しない", () => {
		expect(matchingLines(["ＭＩＬＫ を買う"], textTerms("milk"), 3)).toEqual(["ＭＩＬＫ を買う"]);
	});

	it("語を含む行がなければ、何も取り出さない", () => {
		expect(matchingLines(lines, textTerms("旅行"), 3)).toEqual([]);
	});

	it("前後の空白は取り除く。空の行は取り出さない", () => {
		expect(matchingLines(["  牛乳  ", "   "], textTerms("牛乳"), 3)).toEqual(["牛乳"]);
	});

	it("長い行は、語のまわりだけを切り出す。切ったところには「…」を付ける", () => {
		const long = `${"前".repeat(200)}牛乳${"後".repeat(200)}`;

		const [snippet = ""] = matchingLines([long], textTerms("牛乳"), 3);

		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet).toContain("牛乳");
		expect(snippet.length).toBe(SNIPPET_LENGTH + 2);
	});

	it("行の先頭に近い語なら、先頭から切り出す", () => {
		const long = `牛乳${"後".repeat(200)}`;

		const [snippet = ""] = matchingLines([long], textTerms("牛乳"), 3);

		expect(snippet.startsWith("牛乳")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
	});

	it("行の末尾に近い語なら、末尾までを切り出す", () => {
		const long = `${"前".repeat(200)}牛乳`;

		const [snippet = ""] = matchingLines([long], textTerms("牛乳"), 3);

		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("牛乳")).toBe(true);
		expect(snippet.length).toBe(SNIPPET_LENGTH + 1);
	});

	it.each([
		["始まりが文字の途中になる", `${"🍎".repeat(100)}x牛乳${"後".repeat(200)}`],
		["終わりが文字の途中になる", `牛乳x${"🍊".repeat(100)}`],
	])("切り出すときに、2つの符号単位で表す文字を途中で切らない(%s)", (_name, long) => {
		const [snippet = ""] = matchingLines([long], textTerms("牛乳"), 3);

		expect(snippet.isWellFormed()).toBe(true);
		expect(snippet).toContain("牛乳");
		// 途中で切れた文字は、取り除く。
		expect(snippet.replaceAll("…", "").length).toBe(SNIPPET_LENGTH - 1);
	});

	it("前の文字と合わさって1つの形になる文字(濁点が別の文字になっている半角カナなど)に合うときも、語のまわりを切り出す", () => {
		const long = `${"前".repeat(200)}ｶﾞｲﾄﾞ`;

		const [snippet = ""] = matchingLines([long], textTerms("ガイド"), 3);

		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("ｶﾞｲﾄﾞ")).toBe(true);
	});
});

describe("highlight(語に合うところに印を付けるために、文字列を分ける)", () => {
	it("語に合うところと、合わないところに分ける", () => {
		expect(highlight("牛乳を買う。牛乳は冷蔵庫へ", textTerms("牛乳"))).toEqual([
			{ text: "牛乳", hit: true },
			{ text: "を買う。", hit: false },
			{ text: "牛乳", hit: true },
			{ text: "は冷蔵庫へ", hit: false },
		]);
	});

	it("全角と半角、大文字と小文字の違いは区別しない。表示は、元の文字のまま", () => {
		expect(highlight("Ｍilk Tea", textTerms("MILK tea"))).toEqual([
			{ text: "Ｍilk", hit: true },
			{ text: " ", hit: false },
			{ text: "Tea", hit: true },
		]);
	});

	it("重なって合うところは、1つにまとめる", () => {
		expect(highlight("ababa", textTerms("aba bab"))).toEqual([{ text: "ababa", hit: true }]);
	});

	it("合うところがなければ、全体を1つで返す。空の文字列なら、何も返さない", () => {
		expect(highlight("牛乳", textTerms("卵"))).toEqual([{ text: "牛乳", hit: false }]);
		expect(highlight("", textTerms("卵"))).toEqual([]);
	});

	it.each([
		["濁点が別の文字になっている半角カナ", "ｶﾞｲﾄﾞを読む", "ｶﾞｲﾄﾞ"],
		[
			"濁点を、あとに付く別の文字で書いたかな(分解した形)",
			"カ\u3099イト\u3099を読む",
			"カ\u3099イト\u3099",
		],
	])("前の文字と合わさって1つの形になる文字にも、印を付けられる(%s)", (_name, text, hit) => {
		expect(highlight(text, textTerms("ガイド"))).toEqual([
			{ text: hit, hit: true },
			{ text: "を読む", hit: false },
		]);
	});

	it("あいだに別の記号をはさんで合わさる文字にも、印を付けられる", () => {
		// a + セディーユ + アキュート。アキュートは、セディーユを越えて a と合わさる(á になる)。
		expect(highlight("ca\u0327\u0301fe", textTerms("á"))).toEqual([
			{ text: "c", hit: false },
			{ text: "a\u0327\u0301", hit: true },
			{ text: "fe", hit: false },
		]);
	});

	it("合わさる文字の途中では、印を分けない(濁点だけを、印の外に残さない)", () => {
		// 「カ」は、濁点と合わさった「ガ」には合わない。
		expect(highlight("ｶﾞｲﾄﾞ", textTerms("カ"))).toEqual([{ text: "ｶﾞｲﾄﾞ", hit: false }]);
		expect(highlight("ｶﾞｲﾄﾞ", textTerms("イ"))).toEqual([
			{ text: "ｶﾞ", hit: false },
			{ text: "ｲ", hit: true },
			{ text: "ﾄﾞ", hit: false },
		]);
	});

	it("1文字が複数の文字に変わる文字(㌔ など)にも、印を付けられる", () => {
		expect(highlight("5㌔走る", textTerms("キロ"))).toEqual([
			{ text: "5", hit: false },
			{ text: "㌔", hit: true },
			{ text: "走る", hit: false },
		]);
	});
});
