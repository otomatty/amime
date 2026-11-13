import { describe, expect, it } from "vitest";
import { renameLinks } from "./rename.ts";

/** 書き換えたあとの行。書き換えなかった行は、元のまま。 */
function renamed(lines: readonly string[], from: string, to: string): string[] {
	const result = [...lines];
	for (const { index, text } of renameLinks(lines, from, to)) result[index] = text;
	return result;
}

describe("renameLinks(名前が変わったページへのリンクを書き換える)", () => {
	it("[前の名前] を [新しい名前] に書き換える。書き換えた行だけを返す", () => {
		const lines = ["題", "[牛乳] を買う", "関係ない行", " [牛乳] と [卵]"];

		expect(renameLinks(lines, "牛乳", "豆乳")).toEqual([
			{ index: 1, text: "[豆乳] を買う" },
			{ index: 3, text: " [豆乳] と [卵]" },
		]);
	});

	it("大文字小文字と、空白かアンダースコアかの違いは、同じ名前として書き換える", () => {
		expect(renamed(["題", "[Old Title] [old_title] [OLD TITLE]"], "old title", "New")).toEqual([
			"題",
			"[New] [New] [New]",
		]);
	});

	it("#タグ は、タグのまま書き換える。名前の空白は、アンダースコアにする", () => {
		expect(renamed(["題", "#牛乳 と #牛乳"], "牛乳", "豆乳 メモ")).toEqual([
			"題",
			"#豆乳_メモ と #豆乳_メモ",
		]);
	});

	it("新しい名前をタグとして書けないときは、[新しい名前] にする", () => {
		// バッククォートは、タグの終わりになる。
		expect(renamed(["題", "#牛乳"], "牛乳", "a`b")).toEqual(["題", "[a`b]"]);
	});

	it("装飾・引用・テーブルの中のリンクも書き換える", () => {
		const lines = ["題", "[* 太字の [牛乳]]", "> 引用の #牛乳", "table:表", " [牛乳]\t他のセル"];

		expect(renamed(lines, "牛乳", "豆乳")).toEqual([
			"題",
			"[* 太字の [豆乳]]",
			"> 引用の #豆乳",
			"table:表",
			" [豆乳]\t他のセル",
		]);
	});

	it("1行目(タイトル)、コードの中、他の種類のリンクは書き換えない", () => {
		const lines = [
			"[牛乳]",
			"`[牛乳]` と [/牛乳/牛乳] と [牛乳.icon] と [https://example.com 牛乳]",
			"code:memo",
			" [牛乳]",
		];

		expect(renameLinks(lines, "牛乳", "豆乳")).toEqual([]);
	});

	it("他のページへのリンクは、そのままにする", () => {
		expect(renamed(["題", "[牛乳パック] [牛乳] [牛]"], "牛乳", "豆乳")).toEqual([
			"題",
			"[牛乳パック] [豆乳] [牛]",
		]);
	});

	it.each([
		["括弧を含む", "a]b"],
		["URL", "https://example.com"],
		["装飾の記法になる", "* 太字"],
		["他のプロジェクトへのリンクになる", "/project/page"],
		["アイコンになる", "名前.icon"],
		["前後に空白がある", " 豆乳"],
	])(
		"新しい名前が、[名前] と書いてもそのページへのリンクにならない(%s)ときは、書き換えない",
		(_name, to) => {
			expect(renameLinks(["題", "[牛乳] を買う"], "牛乳", to)).toEqual([]);
		},
	);

	it("書き換えると、行の中の他のリンクが読めなくなるときは、その行を書き換えない", () => {
		// バッククォートを含む名前を2か所に入れると、あいだがコードになり、[卵] がリンクでなくなる。
		expect(renameLinks(["題", "[牛乳] [卵] [牛乳]"], "牛乳", "a`b")).toEqual([]);
		// もともとあるコードと組になって、書き換えたリンクがコードの中に入るときも、書き換えない。
		expect(renameLinks(["題", "[牛乳] と `code`"], "牛乳", "a`b")).toEqual([]);
	});

	it("バッククォートを含む名前でも、他のリンクを壊さなければ、書き換える", () => {
		expect(renamed(["題", "[牛乳] と [卵]"], "牛乳", "a`b")).toEqual(["題", "[a`b] と [卵]"]);
	});

	it("[名前] とは書けない名前でも、タグとして書けるなら、タグは書き換える", () => {
		expect(renamed(["題", "[牛乳] #牛乳"], "牛乳", "* 太字")).toEqual(["題", "[牛乳] #*_太字"]);
	});

	it("タグとしても [名前] としても書けない名前なら、タグも書き換えない", () => {
		expect(renameLinks(["題", "#牛乳"], "牛乳", "a]b")).toEqual([]);
	});
});
