import { afterEach, describe, expect, it, vi } from "vitest";
import { devLogin, loadAccount, loginHref, logout } from "./api.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const stubFetch = (reply: () => Promise<Response> | Response) => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
	vi.stubGlobal("fetch", fetch);
	return fetch;
};

describe("loadAccount(ログインの状態を読む)", () => {
	it("サーバーが返した状態を返す", async () => {
		const state = {
			user: { id: "u1", name: "花子", email: "hanako@example.com", picture: null },
			login: ["google"],
		};
		const fetch = stubFetch(() => Response.json(state));

		expect(await loadAccount()).toEqual(state);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/me", undefined);
	});

	it.each([
		["通信できない", () => Promise.reject(new Error("network"))],
		["サーバーが失敗を返した", () => new Response("x", { status: 500 })],
		["形の違う応答が返った", () => Response.json({ pages: [] })],
		["JSONでない応答が返った", () => new Response("<html>")],
	])("%sときは、ログインしていない扱いにする(ログインの方法も、出さない)", async (_name, reply) => {
		stubFetch(reply);

		expect(await loadAccount()).toEqual({ user: null, login: [] });
	});
});

describe("logout / devLogin", () => {
	it("ログアウトを送り、成功したかを返す", async () => {
		const fetch = stubFetch(() => new Response(null, { status: 204 }));

		expect(await logout()).toBe(true);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/auth/logout", { method: "POST" });
	});

	it("開発用のログインを送り、成功したかを返す", async () => {
		const fetch = stubFetch(() => new Response(null, { status: 204 }));

		expect(await devLogin("hanako")).toBe(true);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/auth/dev", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "hanako" }),
		});
	});

	it.each([
		["サーバーが断った", () => new Response(null, { status: 400 })],
		["通信できない", () => Promise.reject(new Error("network"))],
	])("%sときは、失敗を返す", async (_name, reply) => {
		stubFetch(reply);

		expect(await logout()).toBe(false);
		expect(await devLogin("hanako")).toBe(false);
	});
});

describe("loginHref(ログインを始めるリンク)", () => {
	it("ログインのあとに戻る場所を付ける", () => {
		expect(loginHref("google", "/買い物?a=1")).toBe(
			`/api/auth/login/google?return=${encodeURIComponent("/買い物?a=1")}`,
		);
	});
});
