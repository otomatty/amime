import { env } from "cloudflare:workers";
import type { UserId } from "@amime/sync";
import { beforeAll, describe, expect, it } from "vitest";
import { signIn } from "../auth/accounts.ts";
import {
	acceptInvite,
	canRemove,
	createInvite,
	findInvite,
	INVITE_TTL,
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

/** テストの準備として、メンバーを足す(招待リンクを通さずに)。 */
const join = (id: string, member: UserId, joined: number) =>
	env.DB.prepare(
		`INSERT INTO members (project, user, role, joined) VALUES (?, ?, 'member', ?)
		ON CONFLICT (project, user) DO NOTHING`,
	)
		.bind(id, member, joined)
		.run();

/** 管理者として、招待リンクを作る。 */
async function mustInvite(id: string, admin: UserId, now: number) {
	const invite = await createInvite(env.DB, id, admin, now);
	if (invite === null) throw new Error("the invite was not created");
	return invite;
}

const roles = async (id: string) =>
	Object.fromEntries((await listMembers(env.DB, id)).map((member) => [member.id, member.role]));

beforeAll(() => ready(env.DB));

describe("listMembers", () => {
	it("メンバーを、参加した順に返す", async () => {
		const { id, admin } = await project();
		const [second, third] = [await user("m-second"), await user("m-third")];

		await join(id, third, 3_000);
		await join(id, second, 2_000);
		await join(id, admin, 9_000);

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
		await join(id, await user(), 2_000);

		expect(await setRole(env.DB, id, admin, "member", admin)).toBe("last-admin");
		expect(await removeMember(env.DB, id, admin, admin)).toBe("last-admin");
		// 同じ役割(admin)にするのは、できる。
		expect(await setRole(env.DB, id, admin, "admin", admin)).toBe("changed");
		expect((await roles(id))[admin]).toBe("admin");
	});

	it("管理者が2人いれば、片方を member に戻せる。もう片方は、最後の管理者になる", async () => {
		const { id, admin } = await project();
		const other = await user();
		await join(id, other, 2_000);

		expect(await setRole(env.DB, id, other, "admin", admin)).toBe("changed");
		expect(await setRole(env.DB, id, admin, "member", admin)).toBe("changed");

		expect(await roles(id)).toEqual({ [admin]: "member", [other]: "admin" });
		expect(await removeMember(env.DB, id, other, other)).toBe("last-admin");
		expect(await removeMember(env.DB, id, admin, admin)).toBe("removed");
	});

	it("いないメンバーは unknown。ほかのプロジェクトのメンバーには、触れない", async () => {
		const { id, admin } = await project();
		const other = await project();

		expect(await setRole(env.DB, id, other.admin, "member", admin)).toBe("unknown");
		expect(await removeMember(env.DB, id, other.admin, admin)).toBe("unknown");
		expect(await removeMember(env.DB, id, "nobody" as UserId, admin)).toBe("unknown");
		expect(await roles(other.id)).toEqual({ [other.admin]: "admin" });
	});
});

describe("操作する人が、その時点で管理者であること(確かめたあとで管理者でなくなっても、通さない)", () => {
	it("管理者でない人は、役割を変えられず、ほかの人を外せず、公開範囲を変えられず、招待リンクを作ることも無効にすることもできない", async () => {
		const { id, name, admin } = await project();
		const [member, other, stranger] = [await user(), await user(), await user()];
		await join(id, member, 2_000);
		await join(id, other, 3_000);
		const invite = await mustInvite(id, admin, 1_000);

		for (const actor of [member, stranger]) {
			expect(await setRole(env.DB, id, member, "admin", actor)).toBe("not-admin");
			expect(await removeMember(env.DB, id, other, actor)).toBe("not-admin");
			expect(await setVisibility(env.DB, id, "public", actor)).toBe(false);
			expect(await createInvite(env.DB, id, actor, 4_000)).toBeNull();
			expect(await revokeInvite(env.DB, id, invite.id, actor, 4_000)).toBe(false);
		}

		expect(await roles(id)).toEqual({ [admin]: "admin", [member]: "member", [other]: "member" });
		expect(await findProject(env.DB, name, null)).toMatchObject({ visibility: "private" });
		expect(await listInvites(env.DB, id, 5_000)).toHaveLength(1);
	});

	it("メンバーは、管理者でなくても、自分を外せる", async () => {
		const { id, admin } = await project();
		const member = await user();
		await join(id, member, 2_000);

		expect(await removeMember(env.DB, id, member, member)).toBe("removed");
		expect(await roles(id)).toEqual({ [admin]: "admin" });
	});

	it("canRemove: 外せるかを、先に確かめられる(外さない)", async () => {
		const { id, admin } = await project();
		const member = await user();
		await join(id, member, 2_000);

		expect(await canRemove(env.DB, id, member, admin)).toBe("ok");
		expect(await canRemove(env.DB, id, member, member)).toBe("ok");
		expect(await canRemove(env.DB, id, admin, admin)).toBe("last-admin");
		expect(await canRemove(env.DB, id, admin, member)).toBe("not-admin");
		expect(await canRemove(env.DB, id, "nobody" as UserId, admin)).toBe("unknown");
		expect(await roles(id)).toEqual({ [admin]: "admin", [member]: "member" });
	});
});

describe("setVisibility", () => {
	it("公開範囲を変える", async () => {
		const { id, name, admin } = await project();

		expect(await setVisibility(env.DB, id, "public", admin)).toBe(true);

		expect(await findProject(env.DB, name, null)).toMatchObject({ visibility: "public" });
	});
});

describe("招待リンク", () => {
	it("作ったリンクの値から、招待先を引ける。期限は7日", async () => {
		const { id, name, admin } = await project();

		const invite = await mustInvite(id, admin, 1_000);

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

	it("acceptInvite: 使えるリンクなら、メンバーにして、招待先を返す。もうメンバーなら、役割を変えない", async () => {
		const { id, name, admin } = await project();
		const guest = await user();
		const invite = await mustInvite(id, admin, 1_000);

		expect(await acceptInvite(env.DB, invite.token, guest, 2_000)).toEqual({ id, name });
		expect(await acceptInvite(env.DB, invite.token, guest, 3_000)).toEqual({ id, name });
		expect(await acceptInvite(env.DB, invite.token, admin, 3_000)).toEqual({ id, name });

		expect(await listMembers(env.DB, id)).toMatchObject([
			{ id: admin, role: "admin", joined: 1_000 },
			{ id: guest, role: "member", joined: 2_000 },
		]);
	});

	it("acceptInvite: 無効にされたリンク、期限の切れたリンク、ないリンクでは、メンバーにしない", async () => {
		const { id, admin } = await project();
		const guest = await user();
		const revoked = await mustInvite(id, admin, 1_000);
		const expired = await mustInvite(id, admin, 1_000);
		await revokeInvite(env.DB, id, revoked.id, admin, 2_000);

		expect(await acceptInvite(env.DB, revoked.token, guest, 3_000)).toBeNull();
		expect(await acceptInvite(env.DB, expired.token, guest, 1_000 + INVITE_TTL)).toBeNull();
		expect(await acceptInvite(env.DB, "unknown", guest, 3_000)).toBeNull();

		expect((await listMembers(env.DB, id)).map((member) => member.id)).toEqual([admin]);
	});

	it("一覧は、まだ使えるものだけを、新しい順に返す", async () => {
		const { id, admin } = await project();
		const old = await mustInvite(id, admin, 1_000);
		const revoked = await mustInvite(id, admin, 2_000);
		const fresh = await mustInvite(id, admin, 3_000);
		await revokeInvite(env.DB, id, revoked.id, admin, 4_000);

		const ids = async (now: number) => (await listInvites(env.DB, id, now)).map((item) => item.id);

		expect(await ids(5_000)).toEqual([fresh.id, old.id]);
		expect(await ids(1_000 + INVITE_TTL)).toEqual([fresh.id]);
	});

	it("無効にできるのは、そのプロジェクトの、まだ無効でないリンクだけ", async () => {
		const { id, admin } = await project();
		const other = await project();
		const invite = await mustInvite(id, admin, 1_000);

		expect(await revokeInvite(env.DB, other.id, invite.id, other.admin, 2_000)).toBe(false);
		expect(await revokeInvite(env.DB, id, invite.id, admin, 2_000)).toBe(true);
		expect(await revokeInvite(env.DB, id, invite.id, admin, 3_000)).toBe(false);
		expect(await findInvite(env.DB, invite.token, 3_000)).toBeNull();
	});
});
