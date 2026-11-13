import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

const ORIGIN = "https://amime.test";
type Env = typeof env;
const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

/** 開発用のログインでログインして、Cookie を返す。 */
async function login(name = unique("user")): Promise<string> {
	const response = await exports.default.fetch(`${ORIGIN}/api/auth/dev`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	return (response.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
}

const call = (path: string, init: RequestInit & { cookie?: string } = {}, bindings: Env = env) => {
	const { cookie, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (cookie) headers.set("cookie", cookie);
	return app.request(`${ORIGIN}${path}`, { ...rest, headers }, bindings);
};

const create = (cookie: string | undefined, body: unknown, bindings: Env = env) =>
	call(
		"/api/projects",
		{ method: "POST", body: JSON.stringify(body), ...(cookie ? { cookie } : {}) },
		bindings,
	);

/** プロジェクトを作って、その名前と、管理者の Cookie を返す。 */
async function project(visibility: "public" | "private") {
	const admin = await login();
	const name = unique(visibility);
	expect((await create(admin, { name, visibility })).status).toBe(201);
	return { name, admin };
}

const title = { type: "insert", line: { id: "t", text: "題" }, after: null, before: null };
const commit = (name: string, page: string, cookie?: string) =>
	call(`/api/projects/${name}/pages/${page}/commits`, {
		method: "POST",
		body: JSON.stringify({ id: unique("c"), changes: [title] }),
		...(cookie ? { cookie } : {}),
	});

/** メンバーとして、名前からページを開き(台帳に載せ)、1行目を書く。ページのIDを返す。 */
async function write(name: string, cookie: string, pageTitle = "公開のページ"): Promise<string> {
	const opened = await call(
		`/api/projects/${name}/pages/by-title/${encodeURIComponent(pageTitle)}`,
		{ cookie },
	);
	const { id } = (await opened.json()) as { id: string };
	expect((await commit(name, id, cookie)).status).toBe(200);
	return id;
}

describe("POST /api/projects(プロジェクトを作る)", () => {
	it("作った人が管理者になる。公開範囲を省くと、非公開になる", async () => {
		const cookie = await login();
		const name = unique("team");

		const response = await create(cookie, { name });

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ name, visibility: "private", role: "admin" });
		expect(await (await call(`/api/projects/${name}`, { cookie })).json()).toEqual({
			name,
			visibility: "private",
			role: "admin",
		});
	});

	it("名前の大文字は、小文字にそろえる", async () => {
		const cookie = await login();
		const name = unique("Team");

		const response = await create(cookie, { name, visibility: "public" });

		expect(await response.json()).toEqual({
			name: name.toLowerCase(),
			visibility: "public",
			role: "admin",
		});
	});

	it("同じ名前のプロジェクトがあれば、作らない(先に作った人のものは、そのまま)", async () => {
		const { name, admin } = await project("private");
		const other = await login();

		const response = await create(other, { name });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "name-taken" });
		expect((await call(`/api/projects/${name}`, { cookie: other })).status).toBe(404);
		expect((await call(`/api/projects/${name}`, { cookie: admin })).status).toBe(200);
	});

	it("ログインしていなければ、作れない", async () => {
		const response = await create(undefined, { name: unique("team") });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "login-required" });
	});

	it("作ってよい人の設定にない人は、作れない。設定にある人は、作れる", async () => {
		const name = unique("creator");
		const cookie = await login(name);
		const others = { ...env, PROJECT_CREATORS: "someone@example.com" };
		const listed = { ...env, PROJECT_CREATORS: `someone@example.com, ${name}@dev.invalid` };

		const denied = await create(cookie, { name: unique("team") }, others);

		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ error: "not-allowed" });
		expect((await create(cookie, { name: unique("team") }, listed)).status).toBe(201);
	});

	it("設定がない環境では、誰も作れない", async () => {
		const { PROJECT_CREATORS: _creators, ...rest } = env;

		expect((await create(await login(), { name: unique("team") }, rest as Env)).status).toBe(403);
	});

	it.each([
		["名前がない", {}, "invalid-name"],
		["本文がJSONではない", "x", "invalid-name"],
		["名前に使えない文字がある", { name: "my team" }, "invalid-name"],
		["アプリが使うパスの名前", { name: "api" }, "reserved-name"],
		["知らない公開範囲", { name: "valid-name", visibility: "secret" }, "invalid-visibility"],
	])("%sときは、受け付けない", async (_name, body, error) => {
		const response = await call("/api/projects", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
			cookie: await login(),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error });
	});
});

describe("GET /api/projects(参加しているプロジェクトの一覧)", () => {
	it("自分が参加しているプロジェクトだけを、名前の順に返す", async () => {
		const cookie = await login();
		const b = unique("b");
		const a = unique("a");
		await create(cookie, { name: b, visibility: "public" });
		await create(cookie, { name: a });
		await project("public");

		const response = await call("/api/projects", { cookie });

		expect(await response.json()).toEqual({
			projects: [
				{ name: a, visibility: "private", role: "admin" },
				{ name: b, visibility: "public", role: "admin" },
			],
			canCreate: true,
		});
	});

	it("ログインしていなければ、空の一覧を返す(作ることもできない)", async () => {
		expect(await (await call("/api/projects")).json()).toEqual({ projects: [], canCreate: false });
	});

	it("作ってよい人でなければ、canCreate は false", async () => {
		const response = await call(
			"/api/projects",
			{ cookie: await login() },
			{ ...env, PROJECT_CREATORS: "someone@example.com" },
		);

		expect(await response.json()).toEqual({ projects: [], canCreate: false });
	});
});

describe("非公開のプロジェクト", () => {
	it("メンバーでない人と、ログインしていない人には、ないものとして応える(プロジェクトも、ページのAPIも)", async () => {
		const { name, admin } = await project("private");
		await commit(name, "secret", admin);
		const stranger = await login();

		for (const cookie of [stranger, undefined]) {
			const init = cookie ? { cookie } : {};
			for (const path of [
				"",
				"/pages",
				"/pages/secret",
				"/pages/secret/links",
				"/pages/titles?q=",
				"/pages/search?q=x",
				"/pages/by-title/x",
			]) {
				const response = await call(`/api/projects/${name}${path}`, init);
				expect(response.status, path).toBe(404);
				expect(await response.json()).toEqual({ error: "unknown-project" });
			}
			expect((await commit(name, "secret", cookie)).status).toBe(404);
			const socket = await call(`/api/projects/${name}/pages/secret/socket?client=c1`, {
				...init,
				headers: { Upgrade: "websocket" },
			});
			expect(socket.status).toBe(404);
		}
		// 本文は、変わっていない。
		const page = await call(`/api/projects/${name}/pages/secret`, { cookie: admin });
		expect(await page.json()).toEqual({ version: 1, lines: [{ id: "t", text: "題" }] });
	});

	it("ないプロジェクトも、同じ応答になる", async () => {
		const response = await call(`/api/projects/${unique("none")}`, { cookie: await login() });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "unknown-project" });
	});

	it("名前の形が違うプロジェクトも、同じ応答になる", async () => {
		expect((await call("/api/projects/%E3%83%81%E3%83%BC%E3%83%A0/pages")).status).toBe(404);
	});

	it("プロジェクトの名前は、大文字で書いても同じプロジェクトを指す", async () => {
		const { name, admin } = await project("private");

		const response = await call(`/api/projects/${name.toUpperCase()}`, { cookie: admin });

		expect(response.status).toBe(200);
	});
});

describe("公開のプロジェクト", () => {
	it("メンバーでない人も、ログインしていない人も、読める", async () => {
		const { name, admin } = await project("public");
		const id = await write(name, admin);

		for (const cookie of [await login(), undefined]) {
			const init = cookie ? { cookie } : {};
			const info = await call(`/api/projects/${name}`, init);
			expect(await info.json()).toEqual({ name, visibility: "public", role: null });
			const page = await call(`/api/projects/${name}/pages/${id}`, init);
			expect(await page.json()).toEqual({ version: 1, lines: [{ id: "t", text: "題" }] });
			expect((await call(`/api/projects/${name}/pages`, init)).status).toBe(200);
		}
	});

	it("メンバーでない人は、書き込めない(コミット、固定、削除)", async () => {
		const { name, admin } = await project("public");
		const id = await write(name, admin);

		for (const cookie of [await login(), undefined]) {
			const init = cookie ? { cookie } : {};
			const written = await commit(name, id, cookie);
			expect(written.status).toBe(403);
			expect(await written.json()).toEqual({ error: "read-only" });
			const pinned = await call(`/api/projects/${name}/pages/${id}/pin`, {
				...init,
				method: "PUT",
				body: JSON.stringify({ pinned: true }),
			});
			expect(pinned.status).toBe(403);
			const removed = await call(`/api/projects/${name}/pages/${id}`, {
				...init,
				method: "DELETE",
			});
			expect(removed.status).toBe(403);
		}
		const page = await call(`/api/projects/${name}/pages/${id}`, { cookie: admin });
		expect(await page.json()).toEqual({ version: 1, lines: [{ id: "t", text: "題" }] });
	});

	it("メンバーでない人が、まだないページを名前で開いても、台帳にページを増やさない", async () => {
		const { name, admin } = await project("public");
		const path = `/api/projects/${name}/pages/by-title/${encodeURIComponent("まだない")}`;

		const response = await call(path);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "unknown-page" });
		const id = await env.DB.prepare("SELECT id FROM projects WHERE name = ?")
			.bind(name)
			.first<{ id: string }>();
		const directory = exports.ProjectDO.getByName(id?.id ?? "");
		expect(await directory.find("まだない")).toBeNull();
		// メンバーが開けば、IDが決まる。そのあとは、メンバーでない人にも見える。
		const opened = await (await call(path, { cookie: admin })).json();
		expect(await (await call(path)).json()).toEqual(opened);
	});

	it("メンバーでない人が、台帳にないページのIDを指しても、ページの保存先を作らない(読み込み、つながり、接続)", async () => {
		const { name, admin } = await project("public");
		const id = await env.DB.prepare("SELECT id FROM projects WHERE name = ?")
			.bind(name)
			.first<{ id: string }>();
		const stored = () => exports.PageDO.getByName(`${id?.id}/ghost`).getPage();

		for (const path of ["/pages/ghost", "/pages/ghost/links"]) {
			const response = await call(`/api/projects/${name}${path}`);
			expect(response.status, path).toBe(404);
			expect(await response.json()).toEqual({ error: "unknown-page" });
		}
		const socket = await call(`/api/projects/${name}/pages/ghost/socket?client=c1`, {
			headers: { Upgrade: "websocket" },
		});
		expect(socket.status).toBe(404);

		// メンバーは、まだないページも読める(これから書くページ)。
		const response = await call(`/api/projects/${name}/pages/ghost`, { cookie: admin });
		expect(await response.json()).toEqual({ version: 0, lines: [] });
		expect(await stored()).toEqual({ version: 0, lines: [] });
	});

	it("メンバーでない人の接続は、読むだけの接続になる。カーソルの位置は、他の人に配られない(付いてきた印は、使わない)", async () => {
		const { name, admin } = await project("public");
		const id = await write(name, admin);
		const connect = async (client: string, query: string, cookie?: string) => {
			// 接続は、Worker の入口から行う(テストの中で受け取った接続を、そのまま使うため)。
			const response = await exports.default.fetch(
				`${ORIGIN}/api/projects/${name}/pages/${id}/socket?client=${client}${query}`,
				{ headers: { Upgrade: "websocket", ...(cookie ? { cookie } : {}) } },
			);
			const socket = response.webSocket;
			if (!socket) throw new Error(`upgrade failed: ${response.status}`);
			socket.accept();
			const messages: unknown[] = [];
			socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(String(data))));
			return { socket, messages };
		};
		const cursor = (column: number) => ({ type: "cursor", cursor: { line: "t", column } });
		const member = await connect("member-1", "", admin);
		const viewer = await connect("viewer-1", "&access=write");

		viewer.socket.send(JSON.stringify(cursor(1)));
		member.socket.send(JSON.stringify(cursor(2)));

		// メンバーのカーソルは、読むだけの人にも届く。
		await vi.waitFor(() =>
			expect(viewer.messages.at(-1)).toMatchObject({
				type: "cursor",
				client: "member-1",
				cursor: { line: "t", column: 2 },
			}),
		);
		// 読むだけの人のカーソルは、メンバーに届いていない(先に送ったので、届くなら、もう届いている)。
		expect(
			member.messages.filter((message) => (message as { type: string }).type === "cursor"),
		).toEqual([]);
		// あとから接続した人にも、読むだけの人のカーソルは伝わらない。
		const late = await connect("member-2", "", admin);
		await vi.waitFor(() =>
			expect(late.messages.at(-1)).toMatchObject({ type: "cursor", client: "member-1" }),
		);
		expect(
			late.messages.filter((message) => (message as { client?: string }).client === "viewer-1"),
		).toEqual([]);
		for (const { socket } of [member, viewer, late]) socket.close();
	});
});
