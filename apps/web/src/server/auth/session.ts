import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../context.ts";
import { sameSite } from "../context.ts";
import { ready } from "../db/migrate.ts";
import { findSession, SESSION_TTL } from "./accounts.ts";

/** ログインの状態を入れる Cookie の名前。 */
export const SESSION_COOKIE = "amime_session";

/** https で動いているか。手元の開発(http)では、Cookie に Secure を付けない。 */
export const isSecure = (c: Context<AppEnv>) => new URL(c.req.url).protocol === "https:";

/** ログインの状態を、Cookie に入れる。スクリプトからは読めず、他のサイトからの要求には付かない。 */
export function setSessionCookie(c: Context<AppEnv>, token: string): void {
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		secure: isSecure(c),
		maxAge: SESSION_TTL / 1000,
	});
}

export function clearSessionCookie(c: Context<AppEnv>): void {
	deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c) });
}

/**
 * ログインの状態を読み、利用者を c.var.user に入れる。
 * あわせて、他のサイトのページからの要求を断り、応答をキャッシュさせない。
 */
export const session: MiddlewareHandler<AppEnv> = async (c, next) => {
	// ブラウザは、他のサイトへの要求に Origin を付ける。Cookie は SameSite=Lax だが、
	// WebSocket は他のサイトからでも接続できるので、ここでも止める。
	const origin = c.req.header("origin");
	if (origin !== undefined && !sameSite(origin, c.req.url)) {
		return c.json({ error: "cross-origin" }, 403);
	}
	c.header("cache-control", "no-store");
	await ready(c.env.DB);
	const token = getCookie(c, SESSION_COOKIE);
	const found = token === undefined ? null : await findSession(c.env.DB, token, Date.now());
	c.set("user", found?.account ?? null);
	if (token !== undefined && found?.renewed) setSessionCookie(c, token);
	return next();
};
