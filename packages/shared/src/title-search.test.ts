import { describe, expect, it } from "vitest";
import {
	likePattern,
	MAX_SEARCH_TERMS,
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

	it("語の数と長さには、上限がある", () => {
		const terms = searchTerms(`${"あ".repeat(80)} ${"b ".repeat(20)}`);

		expect(terms).toHaveLength(MAX_SEARCH_TERMS);
		expect(terms[0]).toBe("あ".repeat(50));
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

	it("件数の上限まで返す", () => {
		expect(rankTitles("a", ["a1", "a2", "a3"], 2)).toEqual(["a1", "a2"]);
	});
});

describe("likePattern(文字が順に出てくる名前を探す、LIKE の型)", () => {
	it("語の文字のあいだに、何文字あってもよい型にする", () => {
		expect(likePattern("買物")).toBe("%買%物%");
	});

	it("LIKE で特別な意味を持つ文字は、そのままの文字として探す", () => {
		expect(likePattern("5%_\\")).toBe("%5%\\%%\\_%\\\\%");
	});

	it("2つの符号単位で表す文字を、途中で切らない", () => {
		expect(likePattern("🍎a")).toBe("%🍎%a%");
	});
});
