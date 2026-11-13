import type { Role, Visibility } from "@amime/shared";
import type { Invite, Member, UserId } from "@amime/sync";
import { hashToken, randomToken } from "../auth/crypto.ts";

/** 招待リンクが使える長さ(ミリ秒)。 */
export const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;

/** プロジェクトのメンバーを、参加した順に返す。 */
export async function listMembers(db: D1Database, project: string): Promise<Member[]> {
	const { results } = await db
		.prepare(
			`SELECT u.id, u.name, u.picture, m.role, m.joined
			FROM members m JOIN users u ON u.id = m.user
			WHERE m.project = ? ORDER BY m.joined, u.id`,
		)
		.bind(project)
		.all<Member>();
	return results;
}

/** 管理者が、ほかにいるか(その人を除いて)。 */
const OTHER_ADMIN =
	"EXISTS (SELECT 1 FROM members WHERE project = ? AND role = 'admin' AND user <> ?)";

/**
 * メンバーの役割を変える。管理者が1人もいなくなる変更は、しない。
 * - changed: 変えた
 * - unknown: そのメンバーはいない
 * - last-admin: 最後の管理者を、管理者でなくすことはできない
 */
export async function setRole(
	db: D1Database,
	project: string,
	user: UserId,
	role: Role,
): Promise<"changed" | "unknown" | "last-admin"> {
	// 条件を、1つの文の中で確かめる(確かめてから変えるまでのあいだに、ほかの管理者が外れても、0人にならない)。
	const result = await db
		.prepare(
			`UPDATE members SET role = ?
			WHERE project = ? AND user = ? AND (? = 'admin' OR role <> 'admin' OR ${OTHER_ADMIN})`,
		)
		.bind(role, project, user, role, project, user)
		.run();
	if (result.meta.changes === 1) return "changed";
	return (await isMember(db, project, user)) ? "last-admin" : "unknown";
}

/** メンバーを外す。最後の管理者は、外せない。 */
export async function removeMember(
	db: D1Database,
	project: string,
	user: UserId,
): Promise<"removed" | "unknown" | "last-admin"> {
	const result = await db
		.prepare(
			`DELETE FROM members
			WHERE project = ? AND user = ? AND (role <> 'admin' OR ${OTHER_ADMIN})`,
		)
		.bind(project, user, project, user)
		.run();
	if (result.meta.changes === 1) return "removed";
	return (await isMember(db, project, user)) ? "last-admin" : "unknown";
}

async function isMember(db: D1Database, project: string, user: UserId): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS found FROM members WHERE project = ? AND user = ?")
		.bind(project, user)
		.first();
	return row !== null;
}

/** プロジェクトの公開範囲を変える。 */
export async function setVisibility(
	db: D1Database,
	project: string,
	visibility: Visibility,
): Promise<void> {
	await db
		.prepare("UPDATE projects SET visibility = ? WHERE id = ?")
		.bind(visibility, project)
		.run();
}

/** 招待リンクを作る。token は、リンクに入れる値(ここでしか分からない)。 */
export async function createInvite(
	db: D1Database,
	project: string,
	user: UserId,
	now: number,
): Promise<Invite & { token: string }> {
	const token = randomToken();
	const invite = { id: randomToken(12), created: now, expires: now + INVITE_TTL };
	await db
		.prepare(
			`INSERT INTO invites (id, hash, project, created, created_by, expires)
			VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(invite.id, await hashToken(token), project, now, user, invite.expires)
		.run();
	return { ...invite, token };
}

/** まだ使える招待リンクを、新しい順に返す(リンクに入れた値は、返せない)。 */
export async function listInvites(db: D1Database, project: string, now: number): Promise<Invite[]> {
	const { results } = await db
		.prepare(
			`SELECT id, created, expires FROM invites
			WHERE project = ? AND revoked IS NULL AND expires > ? ORDER BY created DESC, id`,
		)
		.bind(project, now)
		.all<Invite>();
	return results;
}

/** 招待リンクを無効にする。そのプロジェクトの、まだ使えるリンクなら true。 */
export async function revokeInvite(
	db: D1Database,
	project: string,
	id: string,
	now: number,
): Promise<boolean> {
	const result = await db
		.prepare("UPDATE invites SET revoked = ? WHERE id = ? AND project = ? AND revoked IS NULL")
		.bind(now, id, project)
		.run();
	return result.meta.changes === 1;
}

/** 招待リンクの値から、招待先のプロジェクトを引く。使えないリンク(ない、無効、期限切れ)は null。 */
export async function findInvite(
	db: D1Database,
	token: string,
	now: number,
): Promise<{ id: string; name: string } | null> {
	return db
		.prepare(
			`SELECT p.id, p.name FROM invites i JOIN projects p ON p.id = i.project
			WHERE i.hash = ? AND i.revoked IS NULL AND i.expires > ?`,
		)
		.bind(await hashToken(token), now)
		.first<{ id: string; name: string }>();
}

/** メンバーにする。もうメンバーなら、そのまま(役割は変えない)。 */
export async function join(
	db: D1Database,
	project: string,
	user: UserId,
	now: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO members (project, user, role, joined) VALUES (?, ?, 'member', ?)
			ON CONFLICT (project, user) DO NOTHING`,
		)
		.bind(project, user, now)
		.run();
}
