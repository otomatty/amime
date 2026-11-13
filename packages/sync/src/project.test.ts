import { describe, expect, it } from "vitest";
import { parseProjectInfo, parseProjectList } from "./project.ts";

const team = { name: "team", visibility: "private", role: "admin" };

describe("parseProjectInfo(サーバーから届いた、プロジェクトの情報を検査する)", () => {
	it.each([
		["管理者として", team],
		["メンバーとして", { ...team, role: "member" }],
		["メンバーでない人として(公開のプロジェクト)", { ...team, visibility: "public", role: null }],
	])("%s見たプロジェクトを受け付ける", (_name, project) => {
		expect(parseProjectInfo(project)).toEqual({ ok: true, value: project });
	});

	it.each([
		["オブジェクトでない", "team"],
		["名前がない", { visibility: "private", role: null }],
		["知らない公開範囲", { ...team, visibility: "secret" }],
		["知らない役割", { ...team, role: "owner" }],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parseProjectInfo(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseProjectList(サーバーから届いた、参加しているプロジェクトの一覧を検査する)", () => {
	it("一覧と、新しく作れるかどうかを受け付ける", () => {
		const list = { projects: [team, { ...team, name: "other", role: "member" }], canCreate: true };

		expect(parseProjectList(list)).toEqual({ ok: true, value: list });
	});

	it.each([
		["canCreate がない", { projects: [] }],
		["プロジェクトの形が違う", { projects: [{ name: "team" }], canCreate: false }],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parseProjectList(input)).toEqual({ ok: false, error: "invalid" });
	});
});
