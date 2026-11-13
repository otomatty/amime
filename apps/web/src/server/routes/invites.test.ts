import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../app.ts";

const ORIGIN = "https://amime.test";
const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

async function login(): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}/api/auth/dev`, {
		method: "POST",
		body: JSON.stringify({ name: unique("invitee") }),
	});
	return (response.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
}

const call = (path: string, cookie?: string, method = "GET", body?: unknown) =>
	app.request(
		`${ORIGIN}${path}`,
		{
			method,
			headers: cookie ? { cookie } : {},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
		env,
	);

/** プロジェクトと、その招待リンクを作る。 */
async function invited(visibility: "public" | "private" = "private") {
	const admin = await login();
	const name = unique("invites");
	await call("/api/projects", admin, "POST", { name, visibility });
	const created = await call(`/api/projects/${name}/invites`, admin, "POST");
	const { token } = (await created.json()) as { token: string };
	return { name, admin, token };
}

describe("GET /api/invites/:token(招待先を確かめる)", () => {
	it("招待先のプロジェクトの名前と、見ている人が、もうメンバーかを返す", async () => {
		const { name, admin, token } = await invited();

		expect(await (await call(`/api/invites/${token}`)).json()).toEqual({
			project: name,
			member: false,
		});
		expect(await (await call(`/api/invites/${token}`, await login())).json()).toEqual({
			project: name,
			member: false,
		});
		expect(await (await call(`/api/invites/${token}`, admin)).json()).toEqual({
			project: name,
			member: true,
		});
	});

	it("使えないリンクは、理由を区別せずに 404 を返す", async () => {
		const response = await call(`/api/invites/${unique("none")}`);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "unknown-invite" });
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

describe("POST /api/invites/:token/accept(参加する)", () => {
	it("参加すると、非公開のプロジェクトを読み書きできるようになる", async () => {
		const { name, token } = await invited();
		const guest = await login();
		const pages = `/api/projects/${name}/pages`;
		expect((await call(pages, guest)).status).toBe(404);

		const response = await call(`/api/invites/${token}/accept`, guest, "POST");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ project: name, member: true });
		expect((await call(pages, guest)).status).toBe(200);
		const opened = await call(`${pages}/by-title/${encodeURIComponent("最初のページ")}`, guest);
		expect(opened.status).toBe(200);
	});

	it("何度参加しても、メンバーは1人のまま", async () => {
		const { name, admin, token } = await invited();
		const guest = await login();

		await call(`/api/invites/${token}/accept`, guest, "POST");
		await call(`/api/invites/${token}/accept`, guest, "POST");

		const list = await call(`/api/projects/${name}/members`, admin);
		expect(((await list.json()) as { members: unknown[] }).members).toHaveLength(2);
	});

	it("他のサイトからの要求では、参加させない", async () => {
		const { name, token } = await invited();
		const guest = await login();

		const response = await app.request(
			`${ORIGIN}/api/invites/${token}/accept`,
			{ method: "POST", headers: { cookie: guest, origin: "https://evil.example" } },
			env,
		);

		expect(response.status).toBe(403);
		expect((await call(`/api/projects/${name}`, guest)).status).toBe(404);
	});
});
