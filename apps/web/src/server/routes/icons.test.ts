import { runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../app.ts";

const ORIGIN = "https://amime.test";
const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

async function login(name = unique("icon")): Promise<string> {
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
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
		env,
	);

async function project(visibility: "public" | "private" = "private") {
	const admin = await login();
	const name = unique("icons");
	await call("/api/projects", admin, "POST", { name, visibility });
	const row = await env.DB.prepare("SELECT id FROM projects WHERE name = ?")
		.bind(name)
		.first<{ id: string }>();
	return { name, admin, id: row?.id ?? "", path: `/api/projects/${name}` };
}

/** ページを書いて、台帳に反映されるのを待つ。 */
async function write(
	target: { path: string; admin: string; id: string },
	title: string,
	body: string[],
) {
	const opened = await call(
		`${target.path}/pages/by-title/${encodeURIComponent(title)}`,
		target.admin,
	);
	const { id } = (await opened.json()) as { id: string };
	const lines = [title, ...body];
	await call(`${target.path}/pages/${id}/commits`, target.admin, "POST", {
		id: unique("c"),
		changes: lines.map((text, index) => ({
			type: "insert",
			line: { id: `l${index}`, text },
			after: index === 0 ? null : `l${index - 1}`,
			before: null,
		})),
	});
	await runDurableObjectAlarm(exports.PageDO.getByName(`${target.id}/${id}`));
}

const icon = (path: string, name: string, cookie?: string) =>
	call(`${path}/icons/${encodeURIComponent(name)}`, cookie);

describe("GET /api/projects/:project/icons/:name([名前.icon] の画像)", () => {
	it("その名前のページに画像があれば、その画像のURLを返す(名前の大文字と小文字、空白かアンダースコアかは区別しない)", async () => {
		const target = await project();
		await write(target, "Hanako Yamada", ["[https://images.example/hanako.png]", "自己紹介"]);

		const response = await icon(target.path, "hanako_yamada", target.admin);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ url: "https://images.example/hanako.png" });
	});

	it("ページに画像がなければ、その表示名のメンバーのアイコンを返す", async () => {
		const target = await project();
		await call("/api/me", target.admin, "PATCH", {
			name: "山田 花子",
			picture: "https://images.example/profile.png",
		});
		await write(target, "山田 花子", ["画像のないページ"]);

		const response = await icon(target.path, "山田_花子", target.admin);

		expect(await response.json()).toEqual({ url: "https://images.example/profile.png" });
	});

	it("ページの画像を、メンバーのアイコンより優先する", async () => {
		const target = await project();
		await call("/api/me", target.admin, "PATCH", {
			name: "花子",
			picture: "https://images.example/profile.png",
		});
		await write(target, "花子", ["[https://images.example/page.png]"]);

		expect(await (await icon(target.path, "花子", target.admin)).json()).toEqual({
			url: "https://images.example/page.png",
		});
	});

	it("ページも、その表示名のメンバーもなければ(メンバーにアイコンがなくても)、404 を返す", async () => {
		const target = await project();
		await call("/api/me", target.admin, "PATCH", { name: "アイコンなし" });

		for (const name of ["だれでもない", "アイコンなし"]) {
			const response = await icon(target.path, name, target.admin);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "unknown-icon" });
		}
	});

	it("ほかのプロジェクトのメンバーのアイコンは、返さない", async () => {
		const target = await project();
		const other = await project();
		await call("/api/me", other.admin, "PATCH", {
			name: "よその人",
			picture: "https://images.example/other.png",
		});

		expect((await icon(target.path, "よその人", target.admin)).status).toBe(404);
	});

	it("公開のプロジェクトでは、メンバーでない人も引ける。非公開では、引けない", async () => {
		const open = await project("public");
		const closed = await project("private");
		for (const target of [open, closed]) {
			await write(target, "花子", ["[https://images.example/page.png]"]);
		}

		expect((await icon(open.path, "花子")).status).toBe(200);
		const hidden = await icon(closed.path, "花子");
		expect(hidden.status).toBe(404);
		expect(await hidden.json()).toEqual({ error: "unknown-project" });
	});

	it("長すぎる名前は、受け付けない", async () => {
		const target = await project();

		expect((await icon(target.path, "あ".repeat(201), target.admin)).status).toBe(400);
	});
});
