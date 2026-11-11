import { describe, expect, it } from "vitest";
import { parseIndent } from "./indent.ts";

describe("parseIndent", () => {
	it("インデントのない行はレベル0", () => {
		expect(parseIndent("hello")).toEqual({ indent: 0, text: "hello" });
	});

	it.each([
		["半角スペース", " item"],
		["タブ", "\titem"],
		["全角スペース", "\u3000item"],
	])("行頭の%sは1文字で1レベルのインデントになる", (_name, raw) => {
		expect(parseIndent(raw)).toEqual({ indent: 1, text: "item" });
	});

	it("種類の違う空白が混ざっていても文字数でレベルを数える", () => {
		expect(parseIndent(" \t\u3000item")).toEqual({ indent: 3, text: "item" });
	});

	it("行頭以外の空白はインデントに数えない", () => {
		expect(parseIndent(" a b ")).toEqual({ indent: 1, text: "a b " });
	});

	it("空白だけの行は本文が空になる", () => {
		expect(parseIndent("  ")).toEqual({ indent: 2, text: "" });
	});

	it("空行はレベル0で本文が空", () => {
		expect(parseIndent("")).toEqual({ indent: 0, text: "" });
	});
});
