import { Hono } from "hono";

/** HTTP API。パスはすべて /api 配下に置き、それ以外は静的アセット(SPA)が応答する。 */
export const app = new Hono()
	.basePath("/api")
	.get("/health", (c) => c.json({ status: "ok" }))
	.notFound((c) => c.json({ error: "not-found" }, 404));
