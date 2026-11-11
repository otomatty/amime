import { describe, expect, it } from "vitest";
import { toTitleLc } from "./title.ts";

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
