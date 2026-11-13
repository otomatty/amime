import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../context.ts";
import { ready } from "../db/migrate.ts";
import { signIn, startSession } from "./accounts.ts";
import { clearSessionCookie, session, setSessionCookie } from "./session.ts";

const probe = new Hono<AppEnv>()
	.use(session)
	.get("/who", (c) => c.json({ user: c.var.user?.name ?? null }))
	.get("/set", (c) => {
		setSessionCookie(c, "token-1");
		return c.body(null, 204);
	})
	.get("/clear", (c) => {
		clearSessionCookie(c);
		return c.body(null, 204);
	});

const call = (url: string, headers: Record<string, string> = {}) =>
	probe.request(url, { headers }, env);

describe("session(ログインの状態を読む)", () => {
	it("Cookie がなければ、利用者は null。応答は、キャッシュさせない", async () => {
		const response = await call("https://amime.test/who");

		expect(await response.json()).toEqual({ user: null });
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("Cookie の値に当たる利用者を、c.var.user に入れる", async () => {
		await ready(env.DB);
		const subject = `session-mw-${crypto.randomUUID()}`;
		const user = await signIn(
			env.DB,
			"dev",
			{ subject, email: "s@dev.invalid", name: subject, picture: null },
			Date.now(),
		);
		const token = await startSession(env.DB, user, Date.now());

		const response = await call("https://amime.test/who", { cookie: `amime_session=${token}` });

		expect(await response.json()).toEqual({ user: subject });
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("他のサイトのページからの要求は、断る。同じサイトからの要求と、Origin のない要求は、通す", async () => {
		const evil = await call("https://amime.test/who", { origin: "https://evil.example" });
		const same = await call("https://amime.test/who", { origin: "https://amime.test" });

		expect(evil.status).toBe(403);
		expect(await evil.json()).toEqual({ error: "cross-origin" });
		expect(same.status).toBe(200);
	});
});

describe("ログインの状態を入れる Cookie", () => {
	it("スクリプトから読めず、他のサイトからの要求には付かない。https では Secure を付ける", async () => {
		const [cookie = ""] = (await call("https://amime.test/set")).headers.getSetCookie();

		expect(cookie).toBe(
			"amime_session=token-1; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
		);
	});

	it("http(手元の開発)では、Secure を付けない", async () => {
		const [cookie = ""] = (await call("http://localhost:5173/set")).headers.getSetCookie();

		expect(cookie).not.toContain("Secure");
		expect(cookie).toContain("HttpOnly");
	});

	it("消すときは、期限の切れた Cookie で上書きする", async () => {
		const [cookie = ""] = (await call("https://amime.test/clear")).headers.getSetCookie();

		expect(cookie).toMatch(/^amime_session=; Max-Age=0; Path=\//);
	});
});
