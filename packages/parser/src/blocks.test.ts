import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyLines } from "./blocks.ts";

const kinds = (lines: string[]) => classifyLines(lines).map((role) => role.kind);

describe("classifyLines", () => {
	it("1行目はタイトル。それ以外の普通の行は本文", () => {
		expect(classifyLines(["タイトル", "本文", " 箇条書き"])).toEqual([
			{ kind: "title", blockIndent: 0 },
			{ kind: "text", blockIndent: 0 },
			{ kind: "text", blockIndent: 0 },
		]);
	});

	it("行がなければ空", () => {
		expect(classifyLines([])).toEqual([]);
	});

	describe("コードブロック", () => {
		it("code:名前 の行から始まり、それより深くインデントされた行が中身になる", () => {
			expect(classifyLines(["t", "code:a.js", " x", "   y", "z"])).toEqual([
				{ kind: "title", blockIndent: 0 },
				{ kind: "code-head", blockIndent: 0 },
				{ kind: "code-body", blockIndent: 0 },
				{ kind: "code-body", blockIndent: 0 },
				{ kind: "text", blockIndent: 0 },
			]);
		});

		it("インデントされた行からも始められる。中身は、始まりの行より深い行", () => {
			expect(classifyLines(["t", "  code:a", "   x", "  y", " z"])).toEqual([
				{ kind: "title", blockIndent: 0 },
				{ kind: "code-head", blockIndent: 2 },
				{ kind: "code-body", blockIndent: 2 },
				{ kind: "text", blockIndent: 0 },
				{ kind: "text", blockIndent: 0 },
			]);
		});

		it("インデントは、半角スペース・タブ・全角スペースのどれでも数える", () => {
			expect(kinds(["t", "code:a", "\tx", "　y"])).toEqual([
				"title",
				"code-head",
				"code-body",
				"code-body",
			]);
		});

		it("空行で終わる。空白だけの行は、深くインデントされていれば中身のまま", () => {
			expect(kinds(["t", "code:a", " x", "  ", " y", "", " z"])).toEqual([
				"title",
				"code-head",
				"code-body",
				"code-body",
				"code-body",
				"text",
				"text",
			]);
		});

		it("中身の行が code: や table: で始まっていても、新しいブロックにはしない", () => {
			expect(kinds(["t", "code:a", " code:b", " table:c"])).toEqual([
				"title",
				"code-head",
				"code-body",
				"code-body",
			]);
		});

		it("同じ深さに続けて書けば、別のブロックが始まる", () => {
			expect(kinds(["t", "code:a", "code:b", " x"])).toEqual([
				"title",
				"code-head",
				"code-head",
				"code-body",
			]);
		});

		it.each(["code:", "code: ", "xcode:a", "Code:a", "code :a"])(
			"名前のない・形の違う %j は始まりにしない",
			(line) => {
				expect(kinds(["t", line, " x"])).toEqual(["title", "text", "text"]);
			},
		);
	});

	describe("テーブル", () => {
		it("table:名前 の行から始まり、それより深くインデントされた行が行になる", () => {
			expect(classifyLines(["t", " table:予定", "  a\tb", "  c\td", " e"])).toEqual([
				{ kind: "title", blockIndent: 0 },
				{ kind: "table-head", blockIndent: 1 },
				{ kind: "table-row", blockIndent: 1 },
				{ kind: "table-row", blockIndent: 1 },
				{ kind: "text", blockIndent: 0 },
			]);
		});

		it("コードブロックの直後にテーブルを書ける", () => {
			expect(kinds(["t", "code:a", " x", "table:b", " y"])).toEqual([
				"title",
				"code-head",
				"code-body",
				"table-head",
				"table-row",
			]);
		});
	});

	describe("タイトル行", () => {
		it("1行目が code: で始まっていても、ブロックは始めない", () => {
			expect(kinds(["code:a", " x"])).toEqual(["title", "text"]);
		});
	});

	describe("性質", () => {
		const line = fc.string({
			unit: fc.constantFrom(" ", "\t", "　", "code:", "table:", "a", "あ", "x"),
			maxLength: 8,
		});

		it("どんな行の並びでも、行と同じ数の役割を返す。中身の行は必ず始まりの行より深い", () => {
			fc.assert(
				fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
					const roles = classifyLines(lines);
					expect(roles).toHaveLength(lines.length);

					roles.forEach((role, index) => {
						const isBody = role.kind === "code-body" || role.kind === "table-row";
						if (!isBody) return;
						const indent = (lines[index] ?? "").search(/[^ \t　]|$/);
						expect(indent).toBeGreaterThan(role.blockIndent);
						// 直前の行は、同じブロックの始まりか中身である。
						const previous = roles[index - 1];
						expect(previous?.kind.split("-")[0]).toBe(role.kind.split("-")[0]);
						expect(previous?.blockIndent).toBe(role.blockIndent);
					});
				}),
				{ numRuns: 500 },
			);
		});
	});
});
