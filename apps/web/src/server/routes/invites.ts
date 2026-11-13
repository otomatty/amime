import type { InviteTarget } from "@amime/sync";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { acceptInvite, findInvite } from "../db/members.ts";
import { findProject } from "../db/projects.ts";

/** 使えない招待リンク(ない、無効にされた、期限が切れた)への応答。理由は、区別して返さない。 */
const UNKNOWN = { error: "unknown-invite" };

/** 招待リンクで、プロジェクトに参加する(ADR-0034)。 */
export const invites = new Hono<AppEnv>()
	// 招待先を確かめる。リンクを持っている人には、プロジェクトの名前が分かる。
	.get("/:token", async (c) => {
		const invite = await findInvite(c.env.DB, c.req.param("token"), Date.now());
		if (invite === null) return c.json(UNKNOWN, 404);
		const seen = await findProject(c.env.DB, invite.name, c.var.user?.id ?? null);
		const target: InviteTarget = { project: invite.name, member: (seen?.role ?? null) !== null };
		return c.json(target);
	})
	// 参加する。もうメンバーなら、そのまま(役割は変えない)。
	.post("/:token/accept", async (c) => {
		const user = c.var.user;
		if (user === null) return c.json({ error: "login-required" }, 401);
		// リンクが使えることを確かめるのと、メンバーにするのを、まとめて行う。
		const invite = await acceptInvite(c.env.DB, c.req.param("token"), user.id, Date.now());
		if (invite === null) return c.json(UNKNOWN, 404);
		return c.json({ project: invite.name, member: true } satisfies InviteTarget);
	});
