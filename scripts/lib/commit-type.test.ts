import { describe, expect, it } from "vitest";
import { parseCommitType } from "./commit-type.ts";

describe("parseCommitType", () => {
	it.each([
		["feat: 行の分割", "feat"],
		["fix(parser): 全角スペースの扱い", "fix"],
		["refactor(sync)!: 変更の型を整理", "refactor"],
		["FEAT: 大文字", "feat"],
	])("%j から種別 %j を取り出す", (title, expected) => {
		expect(parseCommitType(title)).toBe(expected);
	});

	it.each(["", "行の分割を追加", "feat 行の分割", ": 種別なし"])(
		"Conventional Commits 形式でない %j は undefined",
		(title) => {
			expect(parseCommitType(title)).toBeUndefined();
		},
	);
});
