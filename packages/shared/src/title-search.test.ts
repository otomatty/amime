import { describe, expect, it } from "vitest";
import {
	likePatterns,
	MAX_LIKE_PATTERN_BYTES,
	rankTitles,
	scoreTitle,
	searchTerms,
} from "./title-search.ts";

describe("searchTerms(検索の語)", () => {
	it("空白で区切り、小文字にそろえる。アンダースコアも区切りとして扱う", () => {
		expect(searchTerms("  Milk Tea_メモ　買い物 ")).toEqual(["milk", "tea", "メモ", "買い物"]);
	});

	it("何も入っていなければ、語はない", () => {
		expect(searchTerms("")).toEqual([]);
		expect(searchTerms(" _ ")).toEqual([]);
	});

	it("語の数や長さで、入力を切り捨てない(切り捨てると、合わない名前が候補に出てしまう)", () => {
		const long = "あ".repeat(80);

		expect(searchTerms(`${long} b c d e f g`)).toEqual([long, "b", "c", "d", "e", "f", "g"]);
	});
});

describe("scoreTitle(名前が、検索の語にどれだけ合うか。小さいほど合う)", () => {
	const score = (query: string, title: string) => scoreTitle(searchTerms(query), title);

	it("合わなければ null", () => {
		expect(score("牛乳", "買い物")).toBeNull();
		expect(score("abc", "acb")).toBeNull();
	});

	it("大文字小文字と、空白かアンダースコアかの違いは区別しない", () => {
		expect(score("milk tea", "Milk_Tea")).not.toBeNull();
		expect(score("MILK", "milk tea")).toBe(score("milk", "Milk Tea"));
	});

	it("名前の先頭に合うもの、語の先頭に合うもの、途中に合うもの、文字が飛び飛びに合うもの、の順に合う", () => {
		const whole = score("milk", "Milk");
		const prefix = score("milk", "Milk Tea");
		const word = score("milk", "Hot Milk");
		const inside = score("milk", "Oatmilk");
		const scattered = score("milk", "M.I.L.K");
		const scores = [whole, prefix, word, inside, scattered];

		expect(scores.every((value) => value !== null)).toBe(true);
		expect([...scores].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(scores);
		expect(new Set(scores).size).toBe(scores.length);
	});

	it("同じ文字が繰り返し出てくる名前では、いちばんまとまって合うところで比べる", () => {
		// 「a123aXb」は、後ろの「aXb」で合う(あいだは1文字)。先頭の a から数えない。
		expect(score("ab", "a123aXb") ?? 0).toBeLessThan(score("ab", "a123b") ?? 0);
		expect(score("abc", "a1b1c abXc")).toBe(score("abc", "abXc"));
		// 途中まで合って、続きが出てこない始まりは、数えない。
		expect(score("abc", "ab abXc a")).toBe(score("abc", "abXc"));
	});

	it("文字が飛び飛びに合うときは、まとまっているほうが合う", () => {
		expect(score("買物", "買い物") ?? 0).toBeLessThan(score("買物", "買ったあとで見つけた物") ?? 0);
	});

	it("語が複数あるときは、すべての語が合うものだけ。語の順は問わない", () => {
		expect(score("メモ 買い物", "買い物 メモ")).not.toBeNull();
		expect(score("メモ 旅行", "買い物 メモ")).toBeNull();
	});

	it("語がなければ、どの名前も同じように合う", () => {
		expect(score("", "買い物")).toBe(0);
	});

	it("絵文字などの、2つの符号単位で表す文字も、1文字として合わせる", () => {
		expect(score("🍎🍊", "🍎と🍊")).not.toBeNull();
		expect(score("🍎🍊", "🍊と🍎")).toBeNull();
	});
});

describe("rankTitles(名前を、合う順に並べる)", () => {
	it("合う名前だけを、合う順に並べる。同じくらい合うものは、短い名前を先に、あとは渡された順のまま", () => {
		const titles = ["Oatmilk", "Milk Tea Latte", "買い物", "Milk Tea", "Milk Bar", "Hot Milk"];

		expect(rankTitles("milk", titles, 10)).toEqual([
			"Milk Tea",
			"Milk Bar",
			"Milk Tea Latte",
			"Hot Milk",
			"Oatmilk",
		]);
	});

	it("入力が空なら、渡された順のまま返す(短い名前を先にしない)", () => {
		expect(rankTitles(" ", ["新しいページ", "古い", "中くらい"], 2)).toEqual([
			"新しいページ",
			"古い",
		]);
	});

	it("語がいくつあっても、すべての語が合う名前だけを返す", () => {
		expect(rankTitles("a b c d e f", ["a b c d e", "a b c d e f"], 10)).toEqual(["a b c d e f"]);
	});

	it("件数の上限まで返す", () => {
		expect(rankTitles("a", ["a1", "a2", "a3"], 2)).toEqual(["a1", "a2"]);
	});
});

describe("likePatterns(文字が順に出てくる名前を探す、LIKE の型)", () => {
	/** UTF-8 でのバイト数。 */
	const bytes = (text: string) => encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, "x").length;

	it("語の文字のあいだに、何文字あってもよい型にする", () => {
		expect(likePatterns("買物")).toEqual(["%買%物%"]);
	});

	it("LIKE で特別な意味を持つ文字は、そのままの文字として探す", () => {
		expect(likePatterns("5%_\\")).toEqual(["%5%\\%%\\_%\\\\%"]);
	});

	it("2つの符号単位で表す文字を、途中で切らない", () => {
		expect(likePatterns("🍎a")).toEqual(["%🍎%a%"]);
	});

	it("型の長さには上限がある(SQLite の制限)。長い語は、上限に収まる型に分ける", () => {
		const patterns = likePatterns("あ".repeat(30));

		expect(patterns.length).toBeGreaterThan(1);
		expect(patterns.every((pattern) => bytes(pattern) <= MAX_LIKE_PATTERN_BYTES)).toBe(true);
		// 分けても、語のすべての文字を、順に含む。
		expect(patterns.join("").replaceAll("%", "")).toBe("あ".repeat(30));
	});

	it.each([
		["1バイトの文字", "a", "a", 24],
		["2バイトの文字", "é", "é", 16],
		["3バイトの文字", "あ", "あ", 12],
		["4バイトの文字", "🍎", "🍎", 9],
		["エスケープする文字", "%", "\\%", 16],
	])("%sは、上限に収まる数までを、1つの型に入れる", (_name, character, written, count) => {
		const [first, ...rest] = likePatterns(character.repeat(count + 1));

		expect(first).toBe(`%${`${written}%`.repeat(count)}`);
		expect(bytes(first ?? "")).toBeLessThanOrEqual(MAX_LIKE_PATTERN_BYTES);
		expect(rest).toEqual([`%${written}%`]);
	});

	it("上限ちょうどまでは、1つの型にする", () => {
		// 「%a%a…%」は、文字数の2倍 + 1 バイト。24文字で 49 バイト、25文字で 51 バイト。
		expect(likePatterns("a".repeat(24))).toHaveLength(1);
		expect(likePatterns("a".repeat(25))).toHaveLength(2);
	});

	it("語が空なら、型はない", () => {
		expect(likePatterns("")).toEqual([]);
	});
});
