import { afterEach, describe, expect, it, vi } from "vitest";
import { googleProvider } from "./google.ts";

const env = { GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1" };
const encode = (value: unknown) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll("=", "");
const input = {
	code: "code-1",
	verifier: "verifier-1",
	nonce: "nonce-1",
	redirectUri: "https://amime.test/api/auth/callback/google",
	now: 1_000_000,
};
const claims = {
	iss: "accounts.google.com",
	aud: "client-1",
	exp: 2_000,
	nonce: "nonce-1",
	sub: "g-1",
	email: "hanako@example.com",
	email_verified: true,
	name: "花子",
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("googleProvider", () => {
	it.each([
		["どちらもない", {}],
		["IDがない", { GOOGLE_CLIENT_SECRET: "s" }],
		["シークレットが空", { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "" }],
	])("クライアントIDとシークレットが%sときは、使えない", (_name, incomplete) => {
		expect(googleProvider(incomplete)).toBeNull();
	});

	it("ログイン画面のURLに、照合に使う値を付ける", () => {
		const url = new URL(
			googleProvider(env)?.authorizeUrl({
				state: "state-1",
				nonce: "nonce-1",
				challenge: "challenge-1",
				redirectUri: input.redirectUri,
			}) ?? "",
		);

		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "client-1",
			redirect_uri: input.redirectUri,
			response_type: "code",
			scope: "openid email profile",
			state: "state-1",
			nonce: "nonce-1",
			code_challenge: "challenge-1",
			code_challenge_method: "S256",
		});
	});

	it("code をIDトークンに引き換えて、本人の情報を返す", async () => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
			Response.json({ id_token: `h.${encode(claims)}.s` }),
		);
		vi.stubGlobal("fetch", fetch);

		expect(await googleProvider(env)?.identify(input)).toEqual({
			subject: "g-1",
			email: "hanako@example.com",
			name: "花子",
			picture: null,
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://oauth2.googleapis.com/token");
		expect(init?.method).toBe("POST");
		expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
			grant_type: "authorization_code",
			code: "code-1",
			code_verifier: "verifier-1",
			client_id: "client-1",
			client_secret: "secret-1",
			redirect_uri: input.redirectUri,
		});
	});

	it.each([
		["通信できない", () => Promise.reject(new Error("network"))],
		["Google が断った", () => new Response("no", { status: 400 })],
		["JSONではない", () => new Response("<html>")],
		["IDトークンがない", () => Response.json({ access_token: "a" })],
		["IDトークンが3つの部分に分かれていない", () => Response.json({ id_token: "a.b" })],
		[
			"期限が切れている",
			() => Response.json({ id_token: `h.${encode({ ...claims, exp: 1_000 })}.s` }),
		],
	])("%sときは、本人を確かめられない(null)", async (_name, reply) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => reply()),
		);

		expect(await googleProvider(env)?.identify(input)).toBeNull();
	});
});
