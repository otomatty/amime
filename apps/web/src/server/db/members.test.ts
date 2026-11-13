import { env } from "cloudflare:workers";
import type { UserId } from "@amime/sync";
import { beforeAll, describe, expect, it } from "vitest";
import { signIn } from "../auth/accounts.ts";
import {
	createInvite,
	findInvite,
	INVITE_TTL,
	join,
	listInvites,
	listMembers,
	removeMember,
	revokeInvite,
	setRole,
	setVisibility,
} from "./members.ts";
import { ready } from "./migrate.ts";
import { createProject, findProject } from "./projects.ts";

const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;
const user = (name = unique("m-user")) =>
	signIn(
		env.DB,
		"dev",
		{ subject: name, email: `${name}@dev.invalid`, name, picture: null },
		1_000,
	);

/** プロジェクトを作って、そのIDと、管理者を返す。 */
async function project() {
	const admin = await user();
	const name = unique("m-team");
	await createProject(env.DB, { name, visibility: "private" }, admin, 1_000);
	const found = await findProject(env.DB, name, admin);
	return { id: found?.id ?? "", name, admin };
}

const roles = async (id: string) =>
	Object.fromEntries((await listMembers(env.DB, id)).map((member) => [member.id, member.role]));

beforeAll(() => ready(env.DB));

describe("join / listMembers", () => {
	it("参加した人は member になる。一覧は、参加した順", async () => {
		const { id, admin } = await project();
		const [second, third] = [await user("m-second"), await user("m-third")];

		await join(env.DB, id, third, 3_000);
		await join(env.DB, id, second, 2_000);
		await join(env.DB, id, admin, 9_000);

		expect(await listMembers(env.DB, id)).toEqual([
			{ id: admin, name: expect.any(String), picture: null, role: "admin", joined: 1_000 },
			{ id: second, name: "m-second", picture: null, role: "member", joined: 2_000 },
			{ id: third, name: "m-third", picture: null, role: "member", joined: 3_000 },
		]);
	});
});

describe("setRole / removeMember(管理者を、0人にしない)", () => {
	it("管理者が1人だけのとき、その人を member にも、外すこともできない", async () => {
		const { id, admin } = await project();
		await join(env.DB, id, await user(), 2_000);

		expect(await setRole(env.DB, id, admin, "member")).toBe("last-admin");
		expect(await removeMember(env.DB, id, admin)).toBe("last-admin");
		// 同じ役割(admin)にするのは、できる。
		expect(await setRole(env.DB, id, admin, "admin")).toBe("changed");
		expect((await roles(id))[admin]).toBe("admin");
	});

	it("管理者が2人いれば、片方を member に戻せる。もう片方は、最後の管理者になる", async () => {
		const { id, admin } = await project();
		const other = await user();
		await join(env.DB, id, other, 2_000);

		expect(await setRole(env.DB, id, other, "admin")).toBe("changed");
		expect(await setRole(env.DB, id, admin, "member")).toBe("changed");

		expect(await roles(id)).toEqual({ [admin]: "member", [other]: "admin" });
		expect(await removeMember(env.DB, id, other)).toBe("last-admin");
		expect(await removeMember(env.DB, id, admin)).toBe("removed");
	});

	it("いないメンバーは unknown。ほかのプロジェクトのメンバーには、触れない", async () => {
		const { id } = await project();
		const other = await project();

		expect(await setRole(env.DB, id, other.admin, "member")).toBe("unknown");
		expect(await removeMember(env.DB, id, other.admin)).toBe("unknown");
		expect(await removeMember(env.DB, id, "nobody" as UserId)).toBe("unknown");
		expect(await roles(other.id)).toEqual({ [other.admin]: "admin" });
	});
});

describe("setVisibility", () => {
	it("公開範囲を変える", async () => {
		const { id, name } = await project();

		await setVisibility(env.DB, id, "public");

		expect(await findProject(env.DB, name, null)).toMatchObject({ visibility: "public" });
	});
});

describe("招待リンク", () => {
	it("作ったリンクの値から、招待先を引ける。期限は7日", async () => {
		const { id, name, admin } = await project();

		const invite = await createInvite(env.DB, id, admin, 1_000);

		expect(invite).toEqual({
			id: expect.stringMatching(/^[\w-]{16}$/),
			token: expect.stringMatching(/^[\w-]{43}$/),
			created: 1_000,
			expires: 1_000 + INVITE_TTL,
		});
		expect(await findInvite(env.DB, invite.token, 2_000)).toEqual({ id, name });
		expect(await findInvite(env.DB, invite.token, 1_000 + INVITE_TTL - 1)).toEqual({ id, name });
		expect(await findInvite(env.DB, invite.token, 1_000 + INVITE_TTL)).toBeNull();
		expect(await findInvite(env.DB, invite.id, 2_000)).toBeNull();
	});

	it("一覧は、まだ使えるものだけを、新しい順に返す", async () => {
		const { id, admin } = await project();
		const old = await createInvite(env.DB, id, admin, 1_000);
		const revoked = await createInvite(env.DB, id, admin, 2_000);
		const fresh = await createInvite(env.DB, id, admin, 3_000);
		await revokeInvite(env.DB, id, revoked.id, 4_000);

		const ids = async (now: number) => (await listInvites(env.DB, id, now)).map((item) => item.id);

		expect(await ids(5_000)).toEqual([fresh.id, old.id]);
		expect(await ids(1_000 + INVITE_TTL)).toEqual([fresh.id]);
	});

	it("無効にできるのは、そのプロジェクトの、まだ無効でないリンクだけ", async () => {
		const { id, admin } = await project();
		const other = await project();
		const invite = await createInvite(env.DB, id, admin, 1_000);

		expect(await revokeInvite(env.DB, other.id, invite.id, 2_000)).toBe(false);
		expect(await revokeInvite(env.DB, id, invite.id, 2_000)).toBe(true);
		expect(await revokeInvite(env.DB, id, invite.id, 3_000)).toBe(false);
		expect(await findInvite(env.DB, invite.token, 3_000)).toBeNull();
	});
});
