import { Hono } from "hono";
import { session } from "./auth/session.ts";
import type { AppEnv } from "./context.ts";
import { accountState, auth } from "./routes/auth.ts";
import { projects } from "./routes/projects.ts";

/** HTTP API。パスはすべて /api 配下に置き、それ以外は静的アセット(SPA)が応答する。 */
export const app = new Hono<AppEnv>()
	.basePath("/api")
	.get("/health", (c) => c.json({ status: "ok" }))
	// ここから下は、ログインの状態を読む(ADR-0032)。他のサイトからの要求は、ここで断る。
	.use(session)
	.get("/me", (c) => c.json(accountState(c.env, c.var.user)))
	.route("/auth", auth)
	.route("/projects", projects)
	.notFound((c) => c.json({ error: "not-found" }, 404));
