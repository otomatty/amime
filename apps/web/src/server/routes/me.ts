import { parseDisplayName, parsePictureUrl } from "@amime/shared";
import { Hono } from "hono";
import { updateProfile } from "../auth/accounts.ts";
import { type AppEnv, readJson } from "../context.ts";
import { accountState } from "./auth.ts";

/** ログインしている本人(ADR-0032、ADR-0035)。 */
export const me = new Hono<AppEnv>()
	.get("/", (c) => c.json(accountState(c.env, c.var.user)))
	// 表示名とアイコンを変える。送った項目だけを変える。
	.patch("/", async (c) => {
		const user = c.var.user;
		if (user === null) return c.json({ error: "login-required" }, 401);
		const body = await readJson(c.req.raw);
		const input: Record<string, unknown> =
			typeof body === "object" && body !== null ? { ...body } : {};
		const profile: { name?: string; picture?: string | null } = {};
		if (input["name"] !== undefined) {
			const name = parseDisplayName(input["name"]);
			if (name === null) return c.json({ error: "invalid-name" }, 400);
			profile.name = name;
		}
		if (input["picture"] !== undefined) {
			// null は、アイコンをなくす。
			const picture = input["picture"] === null ? null : parsePictureUrl(input["picture"]);
			if (input["picture"] !== null && picture === null) {
				return c.json({ error: "invalid-picture" }, 400);
			}
			profile.picture = picture;
		}
		if (Object.keys(profile).length === 0) return c.json({ error: "invalid-profile" }, 400);
		await updateProfile(c.env.DB, user.id, profile);
		return c.json(accountState(c.env, { ...user, ...profile }));
	});
