import { describe, expect, it } from "vitest";
import {
	parseInviteTarget,
	parseNewInvite,
	parseProjectInfo,
	parseProjectList,
	parseProjectMembers,
} from "./project.ts";

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

describe("parseProjectMembers(サーバーから届いた、メンバーと招待リンクの一覧を検査する)", () => {
	const member = { id: "u1", name: "花子", picture: null, role: "admin", joined: 1000 };
	const invite = { id: "i1", created: 1000, expires: 2000 };

	it("メンバーと招待リンクを受け付ける", () => {
		const value = {
			members: [
				member,
				{ ...member, id: "u2", picture: "https://x.example/a.png", role: "member" },
			],
			invites: [invite],
		};

		expect(parseProjectMembers(value)).toEqual({ ok: true, value });
	});

	it.each([
		["invites がない", { members: [] }],
		["利用者のIDの形が違う", { members: [{ ...member, id: "a b" }], invites: [] }],
		["知らない役割", { members: [{ ...member, role: "owner" }], invites: [] }],
		["時刻が整数でない", { members: [], invites: [{ ...invite, expires: 1.5 }] }],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parseProjectMembers(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseNewInvite / parseInviteTarget", () => {
	it("作ったばかりの招待リンクを受け付ける", () => {
		const value = { id: "i1", created: 1000, expires: 2000, token: "t-1_x" };

		expect(parseNewInvite(value)).toEqual({ ok: true, value });
		expect(parseNewInvite({ id: "i1", created: 1000, expires: 2000 })).toEqual({
			ok: false,
			error: "invalid",
		});
	});

	it("招待先を受け付ける", () => {
		const value = { project: "team", member: false };

		expect(parseInviteTarget(value)).toEqual({ ok: true, value });
		expect(parseInviteTarget({ project: "team" })).toEqual({ ok: false, error: "invalid" });
	});
});
