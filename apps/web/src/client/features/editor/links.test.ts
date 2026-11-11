import { describe, expect, it } from "vitest";
import { pageHref, projectHref } from "./links.ts";

describe("pageHref", () => {
	it("いまのページからの相対パスにする(同じプロジェクトの中で移動する)", () => {
		expect(pageHref("abc")).toBe("./abc");
	});

	it("空白はアンダースコアにする", () => {
		expect(pageHref("a b c")).toBe("./a_b_c");
	});

	it("URLで意味を持つ文字はエンコードする", () => {
		expect(pageHref("a/b?c#d")).toBe("./a%2Fb%3Fc%23d");
		expect(pageHref("日本語")).toBe("./%E6%97%A5%E6%9C%AC%E8%AA%9E");
	});

	it("スキームに見えるタイトルでも、相対パスのままになる", () => {
		expect(new URL(pageHref("javascript:alert(1)"), "https://amime.test/p/x").href).toBe(
			"https://amime.test/p/javascript%3Aalert(1)",
		);
	});
});

describe("projectHref", () => {
	it("プロジェクトとページを指す絶対パスにする", () => {
		expect(projectHref("help-jp", "文字 装飾")).toBe(
			"/help-jp/%E6%96%87%E5%AD%97_%E8%A3%85%E9%A3%BE",
		);
	});

	it("ページの指定がなければ、プロジェクトのトップを指す", () => {
		expect(projectHref("help-jp", null)).toBe("/help-jp/");
	});
});
