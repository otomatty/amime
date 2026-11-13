import { exports } from "cloudflare:workers";
import { safeReturnPath } from "@amime/shared";
import type { AccountState, LoginMethod } from "@amime/sync";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { endSession, signIn, startSession } from "../auth/accounts.ts";
import { decodeJsonSegment, pkceChallenge, randomToken } from "../auth/crypto.ts";
import { googleProvider } from "../auth/google.ts";
import type { LoginProvider } from "../auth/provider.types.ts";
import { clearSessionCookie, isSecure, SESSION_COOKIE, setSessionCookie } from "../auth/session.ts";
import type { AppEnv } from "../context.ts";
import { readJson } from "../context.ts";
import { listProjectIds } from "../db/projects.ts";

/** ログインを始めてから、提供元から戻ってくるまでのあいだ、照合に使う値を入れる Cookie。 */
const LOGIN_COOKIE = "amime_login";
const LOGIN_COOKIE_PATH = "/api/auth";
/** ログインを始めてから、戻ってくるまでに待つ長さ(秒)。 */
const LOGIN_TTL = 10 * 60;
/** 開発用のログインで使える名前。 */
const DEV_NAME = /^[\w-]{1,40}$/;

/** ログインを始めたときに決めて、戻ってきたときに照らし合わせる値。 */
type Pending = { state: string; nonce: string; verifier: string; returnTo: string };

function readPending(value: string | undefined): Pending | null {
	const pending = value === undefined ? null : decodeJsonSegment(value);
	if (typeof pending !== "object" || pending === null) return null;
	const { state, nonce, verifier, returnTo } = pending as Record<string, unknown>;
	const strings = [state, nonce, verifier, returnTo].every((item) => typeof item === "string");
	return strings ? (pending as Pending) : null;
}

const encodePending = (pending: Pending) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(pending))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");

/** この環境で使える、ログインの提供元。 */
const providers = (env: Cloudflare.Env): Record<string, LoginProvider | null> => ({
	google: googleProvider(env),
});

const devLoginEnabled = (env: Cloudflare.Env) => env.DEV_LOGIN === "enabled";

/** ログインの状態と、この環境で使えるログインの方法。 */
export function accountState(env: Cloudflare.Env, user: AccountState["user"]): AccountState {
	const login: LoginMethod[] = [];
	if (googleProvider(env) !== null) login.push("google");
	if (devLoginEnabled(env)) login.push("dev");
	return { user, login };
}

/** ログインとログアウト(ADR-0032)。 */
export const auth = new Hono<AppEnv>()
	// ログインを始める。照合に使う値を Cookie に入れて、提供元のログイン画面へ送り出す。
	.get("/login/:provider", async (c) => {
		const provider = providers(c.env)[c.req.param("provider")];
		if (provider === undefined) return c.json({ error: "not-found" }, 404);
		if (provider === null) return c.redirect("/?login=unavailable");
		const pending: Pending = {
			state: randomToken(),
			nonce: randomToken(),
			verifier: randomToken(),
			returnTo: safeReturnPath(c.req.query("return")),
		};
		setCookie(c, LOGIN_COOKIE, encodePending(pending), {
			httpOnly: true,
			sameSite: "Lax",
			path: LOGIN_COOKIE_PATH,
			secure: isSecure(c),
			maxAge: LOGIN_TTL,
		});
		return c.redirect(
			provider.authorizeUrl({
				state: pending.state,
				nonce: pending.nonce,
				challenge: await pkceChallenge(pending.verifier),
				redirectUri: new URL(c.req.path.replace("/login/", "/callback/"), c.req.url).href,
			}),
		);
	})
	// 提供元から戻ってきた。始めたときの値と照らし合わせ、本人を確かめて、ログインの状態を作る。
	.get("/callback/:provider", async (c) => {
		const name = c.req.param("provider");
		const provider = providers(c.env)[name];
		if (provider === undefined) return c.json({ error: "not-found" }, 404);
		if (provider === null) return c.redirect("/?login=unavailable");
		const pending = readPending(getCookie(c, LOGIN_COOKIE));
		// 照合に使う値は、1回しか使わない。
		deleteCookie(c, LOGIN_COOKIE, { path: LOGIN_COOKIE_PATH, secure: isSecure(c) });
		const code = c.req.query("code");
		const state = c.req.query("state");
		if (pending === null || code === undefined || state === undefined || state !== pending.state) {
			return c.redirect("/?login=failed");
		}
		const now = Date.now();
		const identity = await provider.identify({
			code,
			verifier: pending.verifier,
			nonce: pending.nonce,
			redirectUri: new URL(c.req.path, c.req.url).href,
			now,
		});
		if (identity === null) return c.redirect("/?login=failed");
		const user = await signIn(c.env.DB, name, identity, now);
		setSessionCookie(c, await startSession(c.env.DB, user, now));
		return c.redirect(safeReturnPath(pending.returnTo));
	})
	// 開発用のログイン。手元での開発と自動テストでだけ使える(公開環境では、無効)。
	.post("/dev", async (c) => {
		if (!devLoginEnabled(c.env)) return c.json({ error: "not-found" }, 404);
		const body = await readJson(c.req.raw);
		const name = typeof body === "object" && body !== null && "name" in body ? body.name : null;
		if (typeof name !== "string" || !DEV_NAME.test(name)) {
			return c.json({ error: "invalid-name" }, 400);
		}
		const now = Date.now();
		const identity = { subject: name, email: `${name}@dev.invalid`, name, picture: null };
		const user = await signIn(c.env.DB, "dev", identity, now);
		setSessionCookie(c, await startSession(c.env.DB, user, now));
		return c.body(null, 204);
	})
	.post("/logout", async (c) => {
		// その人がつないだままの接続を、閉じさせる(ADR-0034)。ほかの端末の接続は、つなぎ直せば続けられる。
		// ログインの状態を消す前と、消したあとの両方で、台帳に覚えさせる
		// (前だけだと、そのあいだにつなぎ直した接続が残る。あとだけだと、失敗したときに接続が残る)。
		const user = c.var.user;
		const joined = user === null ? [] : await listProjectIds(c.env.DB, user.id);
		const revoke = () =>
			Promise.all(joined.map((id) => exports.ProjectDO.getByName(id).revoke(user?.id ?? "")));
		await revoke();
		const token = getCookie(c, SESSION_COOKIE);
		if (token !== undefined) await endSession(c.env.DB, token);
		clearSessionCookie(c);
		await revoke();
		return c.body(null, 204);
	});
