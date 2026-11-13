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
 * 操作する人が、いま、そのプロジェクトの管理者であること。
 * 変更と同じ文の中で確かめる(要求を受け付けたあとで、管理者でなくなった人の変更を、通さない)。
 */
const ACTOR_ADMIN =
	"EXISTS (SELECT 1 FROM members WHERE project = ? AND user = ? AND role = 'admin')";

/** メンバーを変えられない理由。 */
type Refusal =
	/** そのメンバーはいない */
	| "unknown"
	/** 最後の管理者を、外すことも、管理者でなくすこともできない */
	| "last-admin"
	/** 操作する人が、管理者でない */
	| "not-admin";

/** 変える相手の役割、操作する人が管理者か、ほかに管理者がいるか。 */
type Standing = { role: Role | null; admin: number; other: number };

const standing = (db: D1Database, project: string, user: UserId, actor: UserId) =>
	db
		.prepare(
			`SELECT (SELECT role FROM members WHERE project = ? AND user = ?) AS role,
				${ACTOR_ADMIN} AS admin, ${OTHER_ADMIN} AS other`,
		)
		.bind(project, user, project, actor, project, user);

/** メンバーの役割を変えられるか、外せるか。self は、自分に対してなら、管理者でなくてもできる操作か。 */
function judge(found: Standing | undefined, self: boolean, keepsAdmin: boolean): "ok" | Refusal {
	if (found === undefined || (found.admin === 0 && !self)) return "not-admin";
	if (found.role === null) return "unknown";
	return found.role === "admin" && !keepsAdmin && found.other === 0 ? "last-admin" : "ok";
}

/**
 * メンバーの役割を変える。actor は、操作する人(管理者でなければ、変えない)。
 * 管理者が1人もいなくなる変更は、しない。
 */
export async function setRole(
	db: D1Database,
	project: string,
	user: UserId,
	role: Role,
	actor: UserId,
): Promise<"changed" | Refusal> {
	// 条件を、変更と同じ文の中で確かめる(確かめてから変えるまでのあいだに、ほかの管理者が外れても、0人にならない)。
	// 変えられなかった理由は、同じトランザクションの中で、先に読んでおく(D1 の batch は、1つのトランザクション)。
	const [before, changed] = await db.batch<Standing>([
		standing(db, project, user, actor),
		db
			.prepare(
				`UPDATE members SET role = ?
				WHERE project = ? AND user = ? AND ${ACTOR_ADMIN}
					AND (? = 'admin' OR role <> 'admin' OR ${OTHER_ADMIN})`,
			)
			.bind(role, project, user, project, actor, role, project, user),
	]);
	if (changed?.meta.changes === 1) return "changed";
	const reason = judge(before?.results[0], false, role === "admin");
	return reason === "ok" ? "changed" : reason;
}

/**
 * メンバーを外す。actor は、操作する人。管理者は、誰でも外せる。メンバーは、自分だけを外せる(抜ける)。
 * 最後の管理者は、外せない。
 */
export async function removeMember(
	db: D1Database,
	project: string,
	user: UserId,
	actor: UserId,
): Promise<"removed" | Refusal> {
	const [before, removed] = await db.batch<Standing>([
		standing(db, project, user, actor),
		db
			.prepare(
				`DELETE FROM members
				WHERE project = ? AND user = ? AND (user = ? OR ${ACTOR_ADMIN})
					AND (role <> 'admin' OR ${OTHER_ADMIN})`,
			)
			.bind(project, user, actor, project, actor, project, user),
	]);
	if (removed?.meta.changes === 1) return "removed";
	const reason = judge(before?.results[0], user === actor, false);
	return reason === "ok" ? "removed" : reason;
}

/** メンバーを外せるかを、確かめる(外さない)。外す前に、つないだままの接続を閉じさせるかを決めるのに使う。 */
export async function canRemove(
	db: D1Database,
	project: string,
	user: UserId,
	actor: UserId,
): Promise<"ok" | Refusal> {
	const found = await standing(db, project, user, actor).first<Standing>();
	return judge(found ?? undefined, user === actor, false);
}

/** プロジェクトの公開範囲を変える。actor が管理者でなければ、変えずに false を返す。 */
export async function setVisibility(
	db: D1Database,
	project: string,
	visibility: Visibility,
	actor: UserId,
): Promise<boolean> {
	const result = await db
		.prepare(`UPDATE projects SET visibility = ? WHERE id = ? AND ${ACTOR_ADMIN}`)
		.bind(visibility, project, project, actor)
		.run();
	return result.meta.changes === 1;
}

/**
 * 招待リンクを作る。token は、リンクに入れる値(ここでしか分からない)。
 * user(作る人)が管理者でなければ、作らずに null を返す。
 */
export async function createInvite(
	db: D1Database,
	project: string,
	user: UserId,
	now: number,
): Promise<(Invite & { token: string }) | null> {
	const token = randomToken();
	const invite = { id: randomToken(12), created: now, expires: now + INVITE_TTL };
	const result = await db
		.prepare(
			`INSERT INTO invites (id, hash, project, created, created_by, expires)
			SELECT ?, ?, ?, ?, ?, ? WHERE ${ACTOR_ADMIN}`,
		)
		.bind(invite.id, await hashToken(token), project, now, user, invite.expires, project, user)
		.run();
	return result.meta.changes === 1 ? { ...invite, token } : null;
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

/**
 * 招待リンクを無効にする。そのプロジェクトの、まだ使えるリンクなら true。
 * actor(操作する人)が管理者でなければ、無効にせずに false を返す。
 */
export async function revokeInvite(
	db: D1Database,
	project: string,
	id: string,
	actor: UserId,
	now: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE invites SET revoked = ?
			WHERE id = ? AND project = ? AND revoked IS NULL AND ${ACTOR_ADMIN}`,
		)
		.bind(now, id, project, project, actor)
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
			WHERE ${USABLE_INVITE}`,
		)
		.bind(await hashToken(token), now)
		.first<{ id: string; name: string }>();
}

/** 使える招待リンク(無効にされていない、期限が切れていない)であること。 */
const USABLE_INVITE = "i.hash = ? AND i.revoked IS NULL AND i.expires > ?";

/**
 * 招待リンクで、メンバーにする。リンクが使えることを確かめるのと、メンバーにするのを、まとめて行う
 * (確かめたあとでリンクが無効にされても、メンバーにならない)。
 * 使えるリンクなら、招待先のプロジェクトを返す。もうメンバーなら、そのまま(役割は変えない)。使えなければ null。
 */
export async function acceptInvite(
	db: D1Database,
	token: string,
	user: UserId,
	now: number,
): Promise<{ id: string; name: string } | null> {
	const hash = await hashToken(token);
	// 2つの文を、まとめて実行する(D1 の batch は、1つのトランザクションになる)。
	const [, found] = await db.batch<{ id: string; name: string }>([
		db
			.prepare(
				`INSERT INTO members (project, user, role, joined)
				SELECT i.project, ?, 'member', ? FROM invites i WHERE ${USABLE_INVITE}
				ON CONFLICT (project, user) DO NOTHING`,
			)
			.bind(user, now, hash, now),
		db
			.prepare(
				`SELECT p.id, p.name FROM invites i JOIN projects p ON p.id = i.project
				WHERE ${USABLE_INVITE}`,
			)
			.bind(hash, now),
	]);
	return found?.results[0] ?? null;
}
