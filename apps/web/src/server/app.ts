import { Hono } from "hono";
import { session } from "./auth/session.ts";
import type { AppEnv } from "./context.ts";
import { received } from "./received.ts";
import { auth } from "./routes/auth.ts";
import { invites } from "./routes/invites.ts";
import { me } from "./routes/me.ts";
import { projects } from "./routes/projects.ts";

/** HTTP API。パスはすべて /api 配下に置き、それ以外は静的アセット(SPA)が応答する。 */
export const app = new Hono<AppEnv>()
	.basePath("/api")
	.get("/health", (c) => c.json({ status: "ok" }))
	// 本文を、すべて受け取ってから、ログインの状態や権限を確かめる(本文を待つあいだに、権限がなくなった要求を通さない)。
	.use(received)
	// ここから下は、ログインの状態を読む(ADR-0032)。他のサイトからの要求は、ここで断る。
	.use(session)
	.route("/me", me)
	.route("/auth", auth)
	.route("/projects", projects)
	.route("/invites", invites)
	.notFound((c) => c.json({ error: "not-found" }, 404));
