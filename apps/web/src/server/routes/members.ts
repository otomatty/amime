import { exports } from "cloudflare:workers";
import { allows, type Role, type Visibility } from "@amime/shared";
import type { NewInvite, ProjectMembers, UserId } from "@amime/sync";
import { type Context, Hono } from "hono";
import { type AppEnv, readJson } from "../context.ts";
import {
	canRemove,
	createInvite,
	listInvites,
	listMembers,
	removeMember,
	revokeInvite,
	setRole,
	setVisibility,
} from "../db/members.ts";
import { revoking } from "./revoking.ts";

/** プロジェクトの台帳。権限を取り上げたことを、ここに覚えさせる(ページが、つないだままの接続を閉じる)。 */
const directory = (c: Context<AppEnv>) => exports.ProjectDO.getByName(c.var.project.id);

const ROLES: ReadonlySet<unknown> = new Set<Role>(["admin", "member"]);
const VISIBILITIES: ReadonlySet<unknown> = new Set<Visibility>(["public", "private"]);

const can = (c: Context<AppEnv>, action: "write" | "manage") =>
	allows(c.var.project.role, c.var.project.visibility, action);

/** メンバーでない人(公開のプロジェクトを見ているだけの人)への応答。 */
const notMember = (c: Context<AppEnv>) => c.json({ error: "not-member" }, 403);
/** 管理者でない人への応答。 */
const notAdmin = (c: Context<AppEnv>) => c.json({ error: "not-admin" }, 403);

async function field(c: Context<AppEnv>, name: string): Promise<unknown> {
	const body = await readJson(c.req.raw);
	return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : null;
}

/**
 * メンバーを変えられなかったときの応答。いないメンバーを指した、最後の管理者を外そうとした・管理者でなくそうとした、
 * 操作する人が管理者でない(要求を受け付けたあとで、管理者でなくなった場合も含む)。
 */
function refused(c: Context<AppEnv>, result: "unknown" | "last-admin" | "not-admin") {
	if (result === "not-admin") return notAdmin(c);
	return result === "unknown"
		? c.json({ error: "unknown-member" }, 404)
		: c.json({ error: "last-admin" }, 409);
}

/**
 * プロジェクトの設定、メンバー、招待リンク(ADR-0034)。
 * プロジェクトを読めることは、手前で確かめてある(c.var.project)。
 */
export const members = new Hono<AppEnv>()
	// 公開範囲を変える。
	.patch("/", async (c) => {
		if (!can(c, "manage")) return notAdmin(c);
		const visibility = await field(c, "visibility");
		if (!VISIBILITIES.has(visibility)) return c.json({ error: "invalid-visibility" }, 400);
		const actor = c.var.user?.id ?? ("" as UserId);
		const change = () => setVisibility(c.env.DB, c.var.project.id, visibility as Visibility, actor);
		// 非公開にするときは、メンバーでない人がつないだままの接続を、閉じさせる。
		const changed = await (visibility === "private"
			? revoking([directory(c)], "*", change, (done) => done)
			: change());
		if (!changed) return notAdmin(c);
		const { name, role } = c.var.project;
		return c.json({ name, visibility, role });
	})
	// メンバーの一覧。まだ使える招待リンクは、管理者にだけ返す。
	.get("/members", async (c) => {
		if (!can(c, "write")) return notMember(c);
		const { id } = c.var.project;
		const list: ProjectMembers = {
			members: await listMembers(c.env.DB, id),
			invites: can(c, "manage") ? await listInvites(c.env.DB, id, Date.now()) : [],
		};
		return c.json(list);
	})
	// メンバーの役割を変える。
	.put("/members/:user", async (c) => {
		if (!can(c, "manage")) return notAdmin(c);
		const role = await field(c, "role");
		if (!ROLES.has(role)) return c.json({ error: "invalid-role" }, 400);
		const user = c.req.param("user") as UserId;
		const actor = c.var.user?.id ?? ("" as UserId);
		const result = await setRole(c.env.DB, c.var.project.id, user, role as Role, actor);
		return result === "changed" ? c.body(null, 204) : refused(c, result);
	})
	// メンバーを外す。管理者は、誰でも外せる。メンバーは、自分だけを外せる(抜ける)。
	.delete("/members/:user", async (c) => {
		if (!can(c, "write")) return notMember(c);
		const user = c.req.param("user") as UserId;
		const actor = c.var.user?.id ?? ("" as UserId);
		const { id } = c.var.project;
		// 外せないと分かっているときは、接続を閉じさせない(断ったのに、その人の接続だけが閉じる、ということにしない)。
		const allowed = await canRemove(c.env.DB, id, user, actor);
		if (allowed !== "ok") return refused(c, allowed);
		// 外す人がつないだままの接続を、閉じさせる。
		// 確かめたあとで事情が変わって、外せなかったときは、取り上げなかったことにする。
		const result = await revoking(
			[directory(c)],
			user,
			() => removeMember(c.env.DB, id, user, actor),
			(outcome) => outcome === "removed",
		);
		return result === "removed" ? c.body(null, 204) : refused(c, result);
	})
	// 招待リンクを作る。リンクに入れる値は、ここでしか返さない。
	.post("/invites", async (c) => {
		const user = c.var.user;
		if (user === null || !can(c, "manage")) return notAdmin(c);
		const invite: NewInvite | null = await createInvite(
			c.env.DB,
			c.var.project.id,
			user.id,
			Date.now(),
		);
		return invite === null ? notAdmin(c) : c.json(invite, 201);
	})
	// 招待リンクを無効にする。
	.delete("/invites/:id", async (c) => {
		const user = c.var.user;
		if (user === null || !can(c, "manage")) return notAdmin(c);
		const { id } = c.var.project;
		const revoked = await revokeInvite(c.env.DB, id, c.req.param("id"), user.id, Date.now());
		return revoked ? c.body(null, 204) : c.json({ error: "unknown-invite" }, 404);
	});
