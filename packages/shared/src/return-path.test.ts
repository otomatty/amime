import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path.ts";

describe("safeReturnPath(ログインのあとに戻る場所を、このサイトの中に限る)", () => {
	it.each([
		["/", "/"],
		["/買い物", "/買い物"],
		["/team/%E8%B2%B7%E3%81%84%E7%89%A9?q=1#x", "/team/%E8%B2%B7%E3%81%84%E7%89%A9?q=1#x"],
	])("このサイトの中のパスは、そのまま返す(%s)", (value, expected) => {
		expect(safeReturnPath(value)).toBe(expected);
	});

	it.each([
		["指定がない", undefined],
		["空", ""],
		["他のサイトのURL", "https://evil.example/"],
		["スキームを省いた他のサイト", "//evil.example/"],
		["バックスラッシュで書いた他のサイト", "/\\evil.example/"],
		["途中にバックスラッシュ", "/a\\b"],
		["パスで始まらない", "evil.example"],
		["制御文字が入っている", "/a\nb"],
		["長すぎる", `/${"a".repeat(2000)}`],
	])("%s ときは、トップに戻す", (_name, value) => {
		expect(safeReturnPath(value)).toBe("/");
	});
});
