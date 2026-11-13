import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

const ORIGIN = "https://amime.test";
type Env = typeof env;

/** Set-Cookie から、次の要求で送る Cookie を作る(消されたものは除く)。 */
function cookiesFrom(response: Response, previous = ""): string {
	const jar = new Map(
		previous
			.split("; ")
			.filter((pair) => pair !== "")
			.map((pair) => {
				const at = pair.indexOf("=");
				return [pair.slice(0, at), pair.slice(at + 1)] as const;
			}),
	);
	for (const line of response.headers.getSetCookie()) {
		const [pair = ""] = line.split(";");
		const at = pair.indexOf("=");
		const value = pair.slice(at + 1);
		if (value === "" || /max-age=0/i.test(line)) jar.delete(pair.slice(0, at));
		else jar.set(pair.slice(0, at), value);
	}
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

const call = (path: string, init: RequestInit & { cookie?: string } = {}, bindings: Env = env) => {
	const { cookie, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (cookie) headers.set("cookie", cookie);
	return app.request(`${ORIGIN}${path}`, { ...rest, headers, redirect: "manual" }, bindings);
};

const me = async (cookie = "", bindings: Env = env) =>
	(await (await call("/api/me", { cookie }, bindings)).json()) as {
		user: { id: string; name: string; email: string; picture: string | null } | null;
		login: string[];
	};

const devLogin = (name: string, bindings: Env = env) =>
	call(
		"/api/auth/dev",
		{
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ name }),
		},
		bindings,
	);

/** 署名のない、テスト用のIDトークン。 */
function idToken(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replaceAll("=", "");
	return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

/** Google のログイン画面へ送り出すところまで進めて、そのときの値を返す。 */
async function startGoogleLogin(returnTo?: string) {
	const query = returnTo === undefined ? "" : `?return=${encodeURIComponent(returnTo)}`;
	const response = await call(`/api/auth/login/google${query}`);
	const location = new URL(response.headers.get("location") ?? "");
	return { response, location, cookie: cookiesFrom(response) };
}

/** Google のトークンの受け渡し口の代わり。受け取った要求を覚えておく。 */
function stubGoogle(reply: (nonce: string) => Response, nonce: string) {
	const requests: { url: string; body: URLSearchParams }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
			return reply(nonce);
		}),
	);
	return requests;
}

const claimsFor = (nonce: string, more: Record<string, unknown> = {}) => ({
	iss: "https://accounts.google.com",
	aud: env.GOOGLE_CLIENT_ID,
	exp: Math.floor(Date.now() / 1000) + 600,
	nonce,
	sub: `google-${crypto.randomUUID()}`,
	email: "Hanako@Example.com",
	email_verified: true,
	name: "山田 花子",
	picture: "https://images.example/hanako.png",
	...more,
});

const tokenReply = (claims: Record<string, unknown>) =>
	Response.json({ access_token: "a", id_token: idToken(claims), token_type: "Bearer" });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("GET /api/me", () => {
	it("ログインしていなければ、利用者は null。この環境で使えるログインの方法を返す", async () => {
		const response = await call("/api/me");

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ user: null, login: ["google", "dev"] });
	});

	it("Google の設定がない環境では、Google でのログインを方法に含めない", async () => {
		const { GOOGLE_CLIENT_ID: _id, ...rest } = env;

		expect((await me("", rest as Env)).login).toEqual(["dev"]);
		expect((await me("", { ...env, GOOGLE_CLIENT_SECRET: "" })).login).toEqual(["dev"]);
	});

	it("開発用のログインが無効な環境では、方法に含めない", async () => {
		expect((await me("", { ...env, DEV_LOGIN: "disabled" as const })).login).toEqual(["google"]);
	});

	it("でたらめな Cookie では、ログインしていない扱いになる", async () => {
		expect((await me("amime_session=unknown")).user).toBeNull();
	});
});

describe("開発用のログイン(POST /api/auth/dev)", () => {
	it("名前を送るとログインでき、その名前の利用者になる", async () => {
		const response = await devLogin("dev-hanako");

		expect(response.status).toBe(204);
		const [cookie = ""] = response.headers.getSetCookie();
		expect(cookie).toMatch(/^amime_session=[\w-]{40,}; /);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Secure");
		expect(cookie).toMatch(/Max-Age=\d+/);
		expect((await me(cookiesFrom(response))).user).toEqual({
			id: expect.stringMatching(/^[\w-]{10,}$/),
			name: "dev-hanako",
			email: "dev-hanako@dev.invalid",
			picture: null,
		});
	});

	it("同じ名前でログインし直すと、同じ利用者になる。別の名前なら、別の利用者になる", async () => {
		const first = await me(cookiesFrom(await devLogin("dev-same")));
		const second = await me(cookiesFrom(await devLogin("dev-same")));
		const other = await me(cookiesFrom(await devLogin("dev-other")));

		expect(second.user?.id).toBe(first.user?.id);
		expect(other.user?.id).not.toBe(first.user?.id);
	});

	it("無効な環境(公開環境)では、使えない", async () => {
		const response = await devLogin("dev-x", { ...env, DEV_LOGIN: "disabled" as const });

		expect(response.status).toBe(404);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it.each([
		["名前がない", {}],
		["名前が空", { name: " " }],
		["名前に使えない文字がある", { name: "a b" }],
		["名前が長すぎる", { name: "a".repeat(41) }],
	])("%sときは、受け付けない", async (_name, body) => {
		const response = await call("/api/auth/dev", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(400);
	});

	it("他のサイトからの要求は、断る", async () => {
		const response = await call("/api/auth/dev", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body: JSON.stringify({ name: "dev-evil" }),
		});

		expect(response.status).toBe(403);
	});
});

describe("ログアウト(POST /api/auth/logout)", () => {
	it("ログアウトすると Cookie が消え、前の Cookie も使えなくなる", async () => {
		const cookie = cookiesFrom(await devLogin("dev-logout"));

		const response = await call("/api/auth/logout", { method: "POST", cookie });

		expect(response.status).toBe(204);
		expect(cookiesFrom(response, cookie)).toBe("");
		expect((await me(cookie)).user).toBeNull();
	});

	it("ログインしていなくても、失敗しない", async () => {
		expect((await call("/api/auth/logout", { method: "POST" })).status).toBe(204);
	});

	it("他のサイトからの要求は、断る", async () => {
		const cookie = cookiesFrom(await devLogin("dev-logout-evil"));

		const response = await call("/api/auth/logout", {
			method: "POST",
			cookie,
			headers: { origin: "https://evil.example" },
		});

		expect(response.status).toBe(403);
		expect((await me(cookie)).user).not.toBeNull();
	});
});

describe("ログインの期限", () => {
	it("使わないまま30日を過ぎたら、ログインしていない扱いになる", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const cookie = cookiesFrom(await devLogin("dev-expire"));

		vi.setSystemTime(new Date("2026-01-31T00:00:01Z"));
		expect((await me(cookie)).user).toBeNull();
	});

	it("使い続けているあいだは、期限が延びる(Cookie も出し直す)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const cookie = cookiesFrom(await devLogin("dev-renew"));

		// すぐあとの要求では、延ばさない(要求のたびには、書き込まない)。
		vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
		expect((await call("/api/me", { cookie })).headers.getSetCookie()).toEqual([]);
		vi.setSystemTime(new Date("2026-01-20T00:00:00Z"));
		const renewed = await call("/api/me", { cookie });
		expect(renewed.headers.getSetCookie()[0]).toMatch(/^amime_session=.*Max-Age=2592000/);
		expect(cookiesFrom(renewed, cookie)).toBe(cookie);

		vi.setSystemTime(new Date("2026-02-10T00:00:00Z"));
		expect((await me(cookie)).user).not.toBeNull();
	});
});

describe("Google でログインする", () => {
	it("ログインを始めると、Google のログイン画面へ送り出す", async () => {
		const { response, location } = await startGoogleLogin(`/${encodeURIComponent("買い物")}`);

		expect(response.status).toBe(302);
		expect(`${location.origin}${location.pathname}`).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		const query = location.searchParams;
		expect(query.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
		expect(query.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
		expect(query.get("response_type")).toBe("code");
		expect(query.get("scope")).toBe("openid email profile");
		expect(query.get("state")).toMatch(/^[\w-]{20,}$/);
		expect(query.get("nonce")).toMatch(/^[\w-]{20,}$/);
		expect(query.get("code_challenge")).toMatch(/^[\w-]{43}$/);
		expect(query.get("code_challenge_method")).toBe("S256");
		const [cookie = ""] = response.headers.getSetCookie();
		expect(cookie).toMatch(/^amime_login=/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/api/auth");
		// 送り出す先に、照合に使う秘密(合言葉のもと)は出さない。
		expect(location.href).not.toContain("code_verifier");
	});

	it("Google から戻ると、利用者を作ってログインし、もとの場所へ戻す", async () => {
		// 戻る場所は、画面が、URLのパス(符号化されたもの)をそのまま渡してくる。
		const { location, cookie } = await startGoogleLogin(`/${encodeURIComponent("買い物")}?a=1`);
		const state = location.searchParams.get("state") ?? "";
		const nonce = location.searchParams.get("nonce") ?? "";
		const claims = claimsFor(nonce);
		const requests = stubGoogle(() => tokenReply(claims), nonce);

		const response = await call(`/api/auth/callback/google?code=code-1&state=${state}`, { cookie });

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(`/${encodeURIComponent("買い物")}?a=1`);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
		const body = requests[0]?.body;
		expect(body?.get("grant_type")).toBe("authorization_code");
		expect(body?.get("code")).toBe("code-1");
		expect(body?.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
		expect(body?.get("client_secret")).toBe(env.GOOGLE_CLIENT_SECRET);
		expect(body?.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
		// 送り出すときに伝えた値(code_challenge)のもとになった秘密を、ここで渡す。
		const challenge = location.searchParams.get("code_challenge");
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(body?.get("code_verifier") ?? ""),
		);
		const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replaceAll("=", "");
		expect(challenge).toBe(expected);
		const after = cookiesFrom(response, cookie);
		expect(after).toMatch(/^amime_session=/);
		expect((await me(after)).user).toEqual({
			id: expect.any(String),
			name: "山田 花子",
			email: "hanako@example.com",
			picture: "https://images.example/hanako.png",
		});
	});

	it("同じ Google アカウントでログインし直すと、同じ利用者になる。メールアドレスは新しいものに変わる", async () => {
		const login = async (claims: (nonce: string) => Record<string, unknown>) => {
			const { location, cookie } = await startGoogleLogin();
			const nonce = location.searchParams.get("nonce") ?? "";
			stubGoogle(() => tokenReply(claims(nonce)), nonce);
			const state = location.searchParams.get("state") ?? "";
			const response = await call(`/api/auth/callback/google?code=c&state=${state}`, { cookie });
			expect(response.headers.get("location")).toBe("/");
			return me(cookiesFrom(response, cookie));
		};
		const sub = `google-${crypto.randomUUID()}`;

		const first = await login((nonce) => claimsFor(nonce, { sub }));
		const second = await login((nonce) =>
			claimsFor(nonce, { sub, email: "new@example.com", name: "別の名前" }),
		);

		expect(second.user?.id).toBe(first.user?.id);
		expect(second.user?.email).toBe("new@example.com");
		// 名前は、あとから本人が変えられるもの。ログインのたびに上書きしない。
		expect(second.user?.name).toBe("山田 花子");
	});

	it.each([
		["state が、始めたときのものと違う", (state: string) => `code=c&state=${state}x`, true],
		["state がない", () => "code=c", true],
		["code がない", (state: string) => `state=${state}`, true],
		["Google が失敗を返した", (state: string) => `error=access_denied&state=${state}`, true],
		["始めたときの Cookie がない", (state: string) => `code=c&state=${state}`, false],
	])("%sときは、ログインさせずにトップへ戻す", async (_name, query, withCookie) => {
		const { location, cookie } = await startGoogleLogin("/team/memo");
		const nonce = location.searchParams.get("nonce") ?? "";
		const requests = stubGoogle(() => tokenReply(claimsFor(nonce)), nonce);

		const response = await call(
			`/api/auth/callback/google?${query(location.searchParams.get("state") ?? "")}`,
			withCookie ? { cookie } : {},
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/?login=failed");
		expect(requests).toEqual([]);
		expect(cookiesFrom(response, cookie)).not.toContain("amime_session");
	});

	it.each([
		["Google がトークンを渡さなかった", () => new Response("no", { status: 400 })],
		["返ってきたものがJSONではない", () => new Response("<html>")],
		["IDトークンがない", () => Response.json({ access_token: "a" })],
		["IDトークンの形が違う", () => Response.json({ id_token: "a.b" })],
		["IDトークンの中身が読めない", () => Response.json({ id_token: "a.!!!.c" })],
		[
			"合言葉(nonce)が、始めたときのものと違う",
			(nonce: string) => tokenReply(claimsFor(`${nonce}x`)),
		],
		[
			"宛先が、このアプリではない",
			(nonce: string) => tokenReply(claimsFor(nonce, { aud: "other-client" })),
		],
		[
			"メールアドレスが確認されていない",
			(nonce: string) => tokenReply(claimsFor(nonce, { email_verified: false })),
		],
	])("%sときは、ログインさせずにトップへ戻す", async (_name, reply) => {
		const { location, cookie } = await startGoogleLogin();
		const nonce = location.searchParams.get("nonce") ?? "";
		stubGoogle(reply, nonce);

		const response = await call(
			`/api/auth/callback/google?code=c&state=${location.searchParams.get("state")}`,
			{ cookie },
		);

		expect(response.headers.get("location")).toBe("/?login=failed");
		expect(cookiesFrom(response, cookie)).toBe("");
	});

	it("Google と通信できなかったときも、ログインさせずにトップへ戻す", async () => {
		const { location, cookie } = await startGoogleLogin();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network");
			}),
		);

		const response = await call(
			`/api/auth/callback/google?code=c&state=${location.searchParams.get("state")}`,
			{ cookie },
		);

		expect(response.headers.get("location")).toBe("/?login=failed");
	});

	it("戻ってきたときの値は、1回しか使えない(始めたときの Cookie を消す)", async () => {
		const { location, cookie } = await startGoogleLogin();
		const nonce = location.searchParams.get("nonce") ?? "";
		stubGoogle(() => tokenReply(claimsFor(nonce)), nonce);

		const response = await call(
			`/api/auth/callback/google?code=c&state=${location.searchParams.get("state")}`,
			{ cookie },
		);

		expect(cookiesFrom(response, cookie)).not.toContain("amime_login");
	});

	it("戻る場所がとても長くても、照合に使う Cookie は、ブラウザが受け取れる大きさに収まる", async () => {
		const { response } = await startGoogleLogin(`/${"a".repeat(999)}`);
		const oversized = await startGoogleLogin(`/${"あ".repeat(999)}`);

		const [cookie = ""] = response.headers.getSetCookie();
		expect(cookie.length).toBeLessThan(4096);
		expect(oversized.response.headers.getSetCookie()[0]?.length).toBeLessThan(4096);
	});

	it("戻る場所に他のサイトを指定されても、トップへ戻す", async () => {
		const { location, cookie } = await startGoogleLogin("https://evil.example/");
		const nonce = location.searchParams.get("nonce") ?? "";
		stubGoogle(() => tokenReply(claimsFor(nonce)), nonce);

		const response = await call(
			`/api/auth/callback/google?code=c&state=${location.searchParams.get("state")}`,
			{ cookie },
		);

		expect(response.headers.get("location")).toBe("/");
	});

	it("Google の設定がない環境では、ログインを始めずにトップへ戻す", async () => {
		const response = await call("/api/auth/login/google", {}, { ...env, GOOGLE_CLIENT_ID: "" });

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/?login=unavailable");
		const callback = await call(
			"/api/auth/callback/google?code=c&state=s",
			{},
			{ ...env, GOOGLE_CLIENT_ID: "" },
		);
		expect(callback.headers.get("location")).toBe("/?login=unavailable");
	});

	it("http で動かしているとき(手元の開発)は、Cookie に Secure を付けない", async () => {
		const response = await app.request(
			"http://localhost:5173/api/auth/login/google",
			{ redirect: "manual" },
			env,
		);

		expect(response.headers.getSetCookie()[0]).not.toContain("Secure");
		expect(new URL(response.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe(
			"http://localhost:5173/api/auth/callback/google",
		);
	});
});
