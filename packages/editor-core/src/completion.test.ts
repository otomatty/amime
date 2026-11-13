import { describe, expect, it } from "vitest";
import { canCompleteLink, completeLink, linkQueryAt } from "./completion.ts";

const ROLES = {
	text: { kind: "text", blockIndent: 0 },
	"table-row": { kind: "table-row", blockIndent: 0 },
} as const;

/** 「|」をカーソルの位置として、書いている途中のリンクを求める。 */
function queryAt(marked: string, kind: "text" | "table-row" = "text") {
	const column = marked.indexOf("|");
	return linkQueryAt(marked.replace("|", ""), column, ROLES[kind]);
}

/** 「|」をカーソルの位置として、title で補完したあとの行を「|」つきで返す。 */
function complete(marked: string, title: string, kind: "text" | "table-row" = "text"): string {
	const column = marked.indexOf("|");
	const text = marked.replace("|", "");
	const link = linkQueryAt(text, column, ROLES[kind]);
	if (link === null) throw new Error("no link at the cursor");
	const state = completeLink({ lines: ["題", text], cursor: { line: 1, column } }, link, title);
	const [, line = ""] = state.lines;
	expect(state.cursor.line).toBe(1);
	expect(state.anchor).toBeUndefined();
	return `${line.slice(0, state.cursor.column)}|${line.slice(state.cursor.column)}`;
}

describe("linkQueryAt(書いている途中のリンク)", () => {
	describe("[名前]", () => {
		it("開いた括弧からカーソルまでを、名前の一部として返す", () => {
			expect(queryAt("前の文 [買い|")).toEqual({
				kind: "bracket",
				start: 5,
				end: 7,
				closed: false,
				query: "買い",
			});
		});

		it("閉じる括弧がもうあれば、そこまでを置き換える範囲にする", () => {
			expect(queryAt("[買い|物] 後ろ")).toEqual({
				kind: "bracket",
				start: 1,
				end: 4,
				closed: true,
				query: "買い",
			});
		});

		it("後ろに別の括弧が始まっていたら、閉じていないものとして扱う", () => {
			expect(queryAt("[買い| と [別のリンク]")).toMatchObject({ end: 3, closed: false });
		});

		it("装飾の中のリンクも対象にする", () => {
			expect(queryAt("[* 太字の [買い|]]")).toMatchObject({
				kind: "bracket",
				query: "買い",
				closed: true,
			});
		});

		it.each([
			["括弧を開いただけ", "[|"],
			["括弧の外", "[買い物] の|"],
			["括弧がない", "買い|"],
			["空白から始まる", "[ 買い|"],
			["装飾の記法", "[* 太字|"],
			["数式の記法", "[$ x^2|"],
			["URL", "[https://example.com|"],
			["他のプロジェクトへのリンク", "[/project/pa|"],
			["強調の記法", "[[強調|"],
			["閉じた強調の記法", "[[強調|]]"],
			["コードの中", "`[買い|`"],
			["数式の中の括弧", "[$ A[buy|]]"],
			["アイコン", "[買い物.icon|]"],
		])("%sでは、リンクを書いている途中として扱わない", (_name, marked) => {
			expect(queryAt(marked)).toBeNull();
		});

		it.each([
			["コマンドの行", "$ echo [買い|"],
			["コマンドの行(%)", "% ls [買い|"],
			["ヘルプの行", "? 探す [買い|"],
		])("%sでは、リンクにならないので、対象にしない", (_name, marked) => {
			expect(queryAt(marked)).toBeNull();
		});

		it("閉じたコードのあとの括弧は、対象にする", () => {
			expect(queryAt("`code` [買い|")).toMatchObject({ kind: "bracket", query: "買い" });
		});
	});

	describe("#名前", () => {
		it("# からカーソルまでを、名前の一部として返す。置き換える範囲は、タグの終わりまで", () => {
			expect(queryAt("今日の #買い|物 メモ")).toEqual({
				kind: "hashtag",
				start: 5,
				end: 8,
				closed: true,
				query: "買い",
			});
		});

		it("行の先頭の # も対象にする", () => {
			expect(queryAt("#買|")).toMatchObject({ kind: "hashtag", start: 1, end: 2, query: "買" });
		});

		it.each([
			["# だけ", "#|"],
			["文字に続く #(C# など)", "C#メ|"],
			["コードの中", "`#買い|`"],
			["タグの外", "#買い物 の|"],
		])("%sでは、タグを書いている途中として扱わない", (_name, marked) => {
			expect(queryAt(marked)).toBeNull();
		});

		it("前にあるコードやリンクの中の記号に、惑わされない", () => {
			expect(queryAt("`a[b` #買|")).toMatchObject({ kind: "hashtag", query: "買" });
			expect(queryAt("[a`b] #買|")).toMatchObject({ kind: "hashtag", query: "買" });
			expect(queryAt("[a`b] [買|")).toMatchObject({ kind: "bracket", query: "買" });
		});

		it("括弧の中の # は、括弧のリンクの名前の一部として扱う", () => {
			expect(queryAt("[C #メ|")).toMatchObject({ kind: "bracket", query: "C #メ" });
		});
	});
});

describe("テーブルの行", () => {
	it("リンクは、カーソルのあるセルの中だけで読む。他のセルの括弧を、閉じる括弧として扱わない", () => {
		expect(queryAt(" [買|\t別のセル]", "table-row")).toEqual({
			kind: "bracket",
			start: 2,
			end: 3,
			closed: false,
			query: "買",
		});
		// 前のセルの、閉じていない括弧の続きとしても扱わない。
		expect(queryAt(" [前のセル\t買|", "table-row")).toBeNull();
	});

	it("2つめ以降のセルの中のリンクも、行の中の位置で返す", () => {
		expect(queryAt(" 月\t[買|い物]\t水", "table-row")).toEqual({
			kind: "bracket",
			start: 4,
			end: 7,
			closed: true,
			query: "買",
		});
		expect(queryAt(" 月\t#買|\t水", "table-row")).toMatchObject({
			kind: "hashtag",
			start: 4,
			end: 5,
		});
	});

	it("補完しても、他のセルは変えない", () => {
		expect(complete(" [買|\t別のセル]", "買い物", "table-row")).toBe(" [買い物]|\t別のセル]");
	});
});

describe("canCompleteLink(その名前へのリンクとして、補完できるか)", () => {
	const link = linkQueryAt("[買", 2);
	const tag = linkQueryAt("#買", 2);

	it("[名前] と書いて、そのページへのリンクになる名前なら、補完できる", () => {
		if (link === null || tag === null) throw new Error("no link");
		expect(canCompleteLink(link, "買い物 メモ")).toBe(true);
		expect(canCompleteLink(tag, "買い物 メモ")).toBe(true);
	});

	it.each([
		["括弧を含む", "買い物[仮]"],
		["アイコンとして読まれる", "買い物.icon"],
		["URLとして読まれる", "https://example.com/買い物"],
	])("%s名前は、[名前] と書いても別のものとして読まれるので、補完できない", (_name, title) => {
		if (link === null) throw new Error("no link");
		expect(canCompleteLink(link, title)).toBe(false);
	});

	it("タグは、タグとして書ければ補完できる。タグとしても [名前] としても書けない名前は、補完できない", () => {
		if (tag === null) throw new Error("no link");
		expect(canCompleteLink(tag, "買い物.icon")).toBe(true);
		expect(canCompleteLink(tag, "買い物[仮]")).toBe(false);
	});
});

describe("completeLink(書いている途中のリンクを、名前で補完する)", () => {
	it("括弧の中を名前に置き換え、括弧を閉じて、その後ろにカーソルを置く", () => {
		expect(complete("前の文 [買い| 後ろ", "買い物 メモ")).toBe("前の文 [買い物 メモ]| 後ろ");
	});

	it("閉じる括弧がもうあれば、足さない。カーソルは、閉じる括弧の後ろに置く", () => {
		expect(complete("[買い|もの] 後ろ", "買い物 メモ")).toBe("[買い物 メモ]| 後ろ");
	});

	it("タグは、タグのまま補完する。名前の空白は、アンダースコアにする", () => {
		expect(complete("今日の #買い|もの です", "買い物 メモ")).toBe("今日の #買い物_メモ| です");
	});

	it("タグとして書けない名前は、[名前] にする", () => {
		expect(complete("今日の #a| です", "a`b")).toBe("今日の [a`b]| です");
	});

	it("そのページへのリンクとして書けない名前では、何も変えない", () => {
		expect(complete("今日の #買い| です", "買い物[仮]")).toBe("今日の #買い| です");
		expect(complete("[買い|", "買い物.icon")).toBe("[買い|");
	});

	it("補完した文字が、後ろの文字と1文字に結合するときは、その文字の後ろにカーソルを置く", () => {
		// 「]」の直後に、結合する濁点がある。
		expect(complete("[か|゙", "かき")).toBe("[かき]゙|");
	});

	it("選択していた範囲は、選択を外す", () => {
		const text = "[買い";
		const link = linkQueryAt(text, 3);
		if (link === null) throw new Error("no link");

		const state = completeLink(
			{ lines: [text], cursor: { line: 0, column: 3 }, anchor: { line: 0, column: 1 } },
			link,
			"買い物",
		);

		expect(state).toEqual({ lines: ["[買い物]"], cursor: { line: 0, column: 5 } });
	});
});
