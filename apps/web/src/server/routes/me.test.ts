import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../app.ts";

const ORIGIN = "https://amime.test";
const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

async function login(name = unique("me")): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}/api/auth/dev`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	return (response.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
}

const call = (path: string, cookie?: string, method = "GET", body?: unknown) =>
	app.request(
		`${ORIGIN}${path}`,
		{
			method,
			headers: cookie ? { cookie } : {},
			...(body === undefined
				? {}
				: { body: typeof body === "string" ? body : JSON.stringify(body) }),
		},
		env,
	);

const me = async (cookie: string) =>
	((await (await call("/api/me", cookie)).json()) as { user: Record<string, unknown> }).user;

describe("PATCH /api/me(表示名とアイコンを変える)", () => {
	it("表示名を変えられる。前後の空白は取り除く", async () => {
		const cookie = await login();

		const response = await call("/api/me", cookie, "PATCH", { name: "  山田 花子  " });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ user: { name: "山田 花子", picture: null } });
		expect(await me(cookie)).toMatchObject({ name: "山田 花子" });
	});

	it("アイコンの画像のURLを設定でき、なくすこともできる", async () => {
		const cookie = await login();

		await call("/api/me", cookie, "PATCH", { picture: "https://images.example/a.png" });
		expect(await me(cookie)).toMatchObject({ picture: "https://images.example/a.png" });

		await call("/api/me", cookie, "PATCH", { picture: null });
		expect(await me(cookie)).toMatchObject({ picture: null });
	});

	it("送らなかった項目は、変えない", async () => {
		const name = unique("keep");
		const cookie = await login(name);
		await call("/api/me", cookie, "PATCH", { picture: "https://images.example/a.png" });

		await call("/api/me", cookie, "PATCH", { name: "新しい名前" });

		expect(await me(cookie)).toMatchObject({
			name: "新しい名前",
			picture: "https://images.example/a.png",
			email: `${name}@dev.invalid`,
		});
	});

	it("ログインし直しても、変えた表示名とアイコンは、そのまま", async () => {
		const name = unique("again");
		await call("/api/me", await login(name), "PATCH", { name: "変えた名前" });

		expect(await me(await login(name))).toMatchObject({ name: "変えた名前" });
	});

	it.each([
		["表示名が空", { name: "  " }, "invalid-name"],
		["表示名が長すぎる", { name: "あ".repeat(51) }, "invalid-name"],
		["表示名が文字列ではない", { name: 1 }, "invalid-name"],
		[
			"アイコンのURLが https ではない",
			{ picture: "http://images.example/a.png" },
			"invalid-picture",
		],
		["アイコンのURLがスクリプト", { picture: "javascript:alert(1)" }, "invalid-picture"],
		["本文がJSONではない", "x", "invalid-profile"],
		["変える項目がない", {}, "invalid-profile"],
	])("%sときは、受け付けず、何も変えない", async (_name, body, error) => {
		const name = unique("invalid");
		const cookie = await login(name);

		const response = await call("/api/me", cookie, "PATCH", body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error });
		expect(await me(cookie)).toMatchObject({ name, picture: null });
	});

	it("ログインしていなければ、変えられない", async () => {
		const response = await call("/api/me", undefined, "PATCH", { name: "x" });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "login-required" });
	});

	it("メールアドレスなど、ほかの項目は、変えられない", async () => {
		const name = unique("email");
		const cookie = await login(name);

		await call("/api/me", cookie, "PATCH", { name: "x", email: "evil@example.com", id: "other" });

		expect(await me(cookie)).toMatchObject({ name: "x", email: `${name}@dev.invalid` });
	});
});
