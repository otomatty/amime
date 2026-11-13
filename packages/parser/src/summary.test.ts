import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_LINKS, plainLines, summarizePage } from "./summary.ts";

describe("plainLines(ページの行を、読める文字列にする)", () => {
	it("記法の記号と、行頭のインデントを除いた文字列にする。行の数と順は、そのまま", () => {
		expect(
			plainLines([
				"[題] は記法として読まない",
				" [牛乳] を [* 買う] #買い物",
				"",
				"code:memo.js",
				" const [a] = b;",
				"table:予定",
				" 月\t[火]",
				"> 引用の `code`",
			]),
		).toEqual([
			"[題] は記法として読まない",
			"牛乳 を 買う #買い物",
			"",
			"memo.js",
			"const [a] = b;",
			"予定",
			"月 火",
			" 引用の code",
		]);
	});
});

describe("summarizePage(一覧やリンクのつながりのために、ページから取り出す情報)", () => {
	describe("links(ページの中のリンク先)", () => {
		it("[ページ名] と #タグ を、出てきた順に取り出す", () => {
			const { links } = summarizePage(["題", "[牛乳] を買う #買い物", " [卵] も"]);

			expect(links).toEqual(["牛乳", "買い物", "卵"]);
		});

		it("同じ名前へのリンクは、1つにまとめる(大文字小文字と、空白かアンダースコアかの違いは同じ名前)", () => {
			const { links } = summarizePage(["題", "[Page Title] [page_title] #Page_Title"]);

			expect(links).toEqual(["Page Title"]);
		});

		it("装飾・引用・テーブルの中のリンクも取り出す", () => {
			const { links } = summarizePage([
				"題",
				"[* 太字の [中]]",
				"> 引用の [外]",
				"table:表",
				" [セル]\t#タグ",
			]);

			expect(links).toEqual(["中", "外", "セル", "タグ"]);
		});

		it("外部リンク、他のプロジェクトへのリンク、画像、アイコンは含めない", () => {
			const { links } = summarizePage([
				"題",
				"[https://example.com] [/other/page] [https://example.com/a.png] [bob.icon]",
			]);

			expect(links).toEqual([]);
		});

		it("コードブロックとコードの中は、リンクにしない", () => {
			const { links } = summarizePage(["題", "code:a.js", " items[0] [x]", "`[y]`"]);

			expect(links).toEqual([]);
		});

		it("1行目(タイトル)は、記法として読まない", () => {
			expect(summarizePage(["[題] #tag"]).links).toEqual([]);
		});

		it("取り出すリンクの数には上限がある", () => {
			const many = Array.from({ length: MAX_SUMMARY_LINKS + 10 }, (_, index) => `[p${index}]`);

			expect(summarizePage(["題", ...many]).links).toHaveLength(MAX_SUMMARY_LINKS);
		});
	});

	describe("descriptions(冒頭の本文)", () => {
		it("タイトルの次の行から、空でない行を5行まで取り出す", () => {
			const { descriptions } = summarizePage(["題", "", "1", " 2", "3", "4", "5", "6"]);

			expect(descriptions).toEqual(["1", "2", "3", "4", "5"]);
		});

		it("記法の記号を除いた、読める文字列にする", () => {
			const { descriptions } = summarizePage([
				"題",
				"[牛乳] を [* 2本] 買う #買い物 `code` [$ x^2]",
				"> 引用 [Example https://example.com]",
				"$ pnpm dev",
			]);

			expect(descriptions).toEqual([
				"牛乳 を 2本 買う #買い物 code x^2",
				"引用 Example",
				// コマンドの行は、行頭の記号も含めて中身として扱う。
				"$ pnpm dev",
			]);
		});

		it("画像とアイコンは、文字にしない。それだけの行は、空の行として飛ばす", () => {
			const { descriptions } = summarizePage([
				"題",
				"[https://example.com/a.png]",
				"[bob.icon] 本文",
			]);

			expect(descriptions).toEqual(["本文"]);
		});

		it("コードブロックとテーブルは、名前と中身を取り出す", () => {
			const { descriptions } = summarizePage([
				"題",
				"code:hello.js",
				" return 1;",
				"table:予定",
				" 月\t[会議]",
			]);

			expect(descriptions).toEqual(["hello.js", "return 1;", "予定", "月 会議"]);
		});

		it("長い行は、200文字までにする。文字の途中で切らない", () => {
			const { descriptions } = summarizePage(["題", `${"あ".repeat(199)}😀😀`]);

			expect(descriptions).toEqual(["あ".repeat(199)]);
			expect(summarizePage(["題", "あ".repeat(250)]).descriptions).toEqual(["あ".repeat(200)]);
		});

		it("本文のないページでは、空", () => {
			expect(summarizePage(["題"]).descriptions).toEqual([]);
			expect(summarizePage([]).descriptions).toEqual([]);
		});
	});

	describe("image(最初の画像)", () => {
		it("ページの中の最初の画像のURLを取り出す", () => {
			const { image } = summarizePage([
				"題",
				"本文",
				" [https://example.com/a.png]",
				"[https://example.com/b.jpg]",
			]);

			expect(image).toBe("https://example.com/a.png");
		});

		it("リンク付きの画像と、装飾の中の画像も対象にする", () => {
			expect(summarizePage(["題", "[https://example.com https://example.com/a.png]"]).image).toBe(
				"https://example.com/a.png",
			);
			expect(summarizePage(["題", "[* [https://example.com/c.gif]]"]).image).toBe(
				"https://example.com/c.gif",
			);
		});

		it("画像がなければ null", () => {
			expect(summarizePage(["題", "本文"]).image).toBeNull();
		});
	});
});
