import { describe, expect, it } from "vitest";
import { MAX_TITLE_LENGTH, titleFromName, titleOfLine, toTitleLc } from "./title.ts";

describe("toTitleLc", () => {
	it.each([
		["Hello", "hello"],
		["Hello World", "hello_world"],
		["a  b", "a__b"],
		["already_snake", "already_snake"],
		["日本語のタイトル", "日本語のタイトル"],
		["Mixed 日本語 Title", "mixed_日本語_title"],
		["", ""],
	])("%j を %j に正規化する", (title, expected) => {
		expect(toTitleLc(title)).toBe(expected);
	});

	it("大文字小文字と空白/アンダースコアの違いだけなら同じページとして扱える", () => {
		expect(toTitleLc("Page Title")).toBe(toTitleLc("page_title"));
	});
});

describe("titleFromName", () => {
	it("URLの中の名前を、タイトルにする(アンダースコアを空白に戻す)", () => {
		expect(titleFromName("買い物_メモ")).toBe("買い物 メモ");
		expect(titleFromName("plain")).toBe("plain");
	});
});

describe("titleOfLine", () => {
	it("ページの1行目から、タイトルを求める(前後の空白は含めない)", () => {
		expect(titleOfLine("買い物メモ")).toBe("買い物メモ");
		expect(titleOfLine("  買い物 メモ\u3000")).toBe("買い物 メモ");
	});

	it("空白だけの行は、空のタイトルになる", () => {
		expect(titleOfLine(" \t\u3000")).toBe("");
	});
});

describe("MAX_TITLE_LENGTH", () => {
	it("タイトルの長さの上限は200文字", () => {
		expect(MAX_TITLE_LENGTH).toBe(200);
	});
});
