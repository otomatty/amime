import { describe, expect, it } from "vitest";
import { allows, canCreateProject, parseProjectName } from "./access.ts";

describe("allows(プロジェクトで、その操作をしてよいか)", () => {
	it.each([
		// 役割, 公開範囲, 読む, 書く, 管理する
		["admin", "private", true, true, true],
		["admin", "public", true, true, true],
		["member", "private", true, true, false],
		["member", "public", true, true, false],
		[null, "public", true, false, false],
		[null, "private", false, false, false],
	] as const)("役割 %s、%s のプロジェクト", (role, visibility, read, write, manage) => {
		expect(allows(role, visibility, "read")).toBe(read);
		expect(allows(role, visibility, "write")).toBe(write);
		expect(allows(role, visibility, "manage")).toBe(manage);
	});
});

describe("parseProjectName(プロジェクトの名前。URLの最初の部分になる)", () => {
	it.each(["team", "my-team-2", "a1", "a".repeat(40)])("%s は使える", (name) => {
		expect(parseProjectName(name)).toEqual({ ok: true, value: name });
	});

	it("大文字は、小文字にそろえる", () => {
		expect(parseProjectName("My-Team")).toEqual({ ok: true, value: "my-team" });
	});

	it.each([
		["文字列ではない", 1],
		["空", ""],
		["1文字", "a"],
		["長すぎる", "a".repeat(41)],
		["日本語", "チーム"],
		["空白がある", "my team"],
		["記号がある", "my_team"],
		["ハイフンで始まる", "-team"],
		["ハイフンで終わる", "team-"],
		["ハイフンが続く", "my--team"],
	])("%s名前は使えない", (_name, value) => {
		expect(parseProjectName(value)).toEqual({ ok: false, error: "invalid" });
	});

	it.each(["api", "assets", "settings", "invite", "new", "login", "API"])(
		"アプリが使うパス(%s)は、名前にできない",
		(name) => {
			expect(parseProjectName(name)).toEqual({ ok: false, error: "reserved" });
		},
	);
});

describe("canCreateProject(プロジェクトを新しく作ってよい人か)", () => {
	it("設定がなければ、誰も作れない", () => {
		expect(canCreateProject(undefined, "hanako@example.com")).toBe(false);
		expect(canCreateProject("", "hanako@example.com")).toBe(false);
	});

	it("* なら、ログインしていれば誰でも作れる", () => {
		expect(canCreateProject("*", "hanako@example.com")).toBe(true);
	});

	it("メールアドレスを並べた設定なら、そこにある人だけが作れる(大文字と小文字、前後の空白は区別しない)", () => {
		const setting = "Hanako@Example.com, taro@example.com ,";

		expect(canCreateProject(setting, "hanako@example.com")).toBe(true);
		expect(canCreateProject(setting, "TARO@example.com")).toBe(true);
		expect(canCreateProject(setting, "jiro@example.com")).toBe(false);
		expect(canCreateProject(setting, "")).toBe(false);
	});
});
