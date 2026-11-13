import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path.ts";

describe("safeReturnPath(ログインのあとに戻る場所を、このサイトの中に限る)", () => {
	it.each([
		["/", "/"],
		["/team/memo", "/team/memo"],
		["/team/%E8%B2%B7%E3%81%84%E7%89%A9?q=1#x", "/team/%E8%B2%B7%E3%81%84%E7%89%A9?q=1#x"],
		[`/${"a".repeat(999)}`, `/${"a".repeat(999)}`],
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
		["空白が入っている", "/a b"],
		// URLのパスは、符号化されていれば ASCII だけになる。Cookie に入れる大きさを、文字数で抑えられる。
		["符号化されていない文字が入っている", "/買い物"],
		["長すぎる", `/${"a".repeat(2000)}`],
	])("%s ときは、トップに戻す", (_name, value) => {
		expect(safeReturnPath(value)).toBe("/");
	});
});
