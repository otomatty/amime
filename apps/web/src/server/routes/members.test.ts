import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

const ORIGIN = "https://amime.test";
const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

type Session = { cookie: string; id: string; name: string };

/** 開発用のログインでログインして、Cookie と利用者のIDを返す。 */
async function login(name = unique("user")): Promise<Session> {
	const response = await exports.default.fetch(`${ORIGIN}/api/auth/dev`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	const cookie = (response.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
	const me = await app.request(`${ORIGIN}/api/me`, { headers: { cookie } }, env);
	const { user } = (await me.json()) as { user: { id: string } };
	return { cookie, id: user.id, name };
}

const call = (path: string, init: RequestInit & { as?: Session } = {}) => {
	const { as, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (as) headers.set("cookie", as.cookie);
	return app.request(`${ORIGIN}${path}`, { ...rest, headers }, env);
};
const send = (method: string, path: string, as: Session | undefined, body?: unknown) =>
	call(path, {
		method,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		...(as ? { as } : {}),
	});

/** プロジェクトを作る。admin が管理者。 */
async function project(visibility: "public" | "private" = "private") {
	const admin = await login();
	const name = unique("members");
	await send("POST", "/api/projects", admin, { name, visibility });
	return { name, admin, path: `/api/projects/${name}` };
}

/** 招待リンクを作って、その値を返す。 */
async function invite(path: string, admin: Session): Promise<{ id: string; token: string }> {
	const response = await send("POST", `${path}/invites`, admin);
	expect(response.status).toBe(201);
	return (await response.json()) as { id: string; token: string };
}

/** 招待リンクで参加したメンバーを作る。 */
async function member(path: string, admin: Session): Promise<Session> {
	const joined = await login();
	const { token } = await invite(path, admin);
	expect((await send("POST", `/api/invites/${token}/accept`, joined)).status).toBe(200);
	return joined;
}

const membersOf = async (path: string, as: Session) =>
	(await (await call(`${path}/members`, { as })).json()) as {
		members: { id: string; name: string; role: string }[];
		invites: { id: string; created: number; expires: number }[];
	};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("招待リンク", () => {
	it("管理者が作れる。リンクに入れる値は、作ったときにだけ返る。期限は7日", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const { path, admin } = await project();

		const response = await send("POST", `${path}/invites`, admin);

		const created = (await response.json()) as { id: string; token: string; expires: number };
		expect(response.status).toBe(201);
		expect(created).toEqual({
			id: expect.stringMatching(/^[\w-]{16}$/),
			token: expect.stringMatching(/^[\w-]{43}$/),
			created: Date.parse("2026-01-01T00:00:00Z"),
			expires: Date.parse("2026-01-08T00:00:00Z"),
		});
		const { invites } = await membersOf(path, admin);
		expect(invites).toEqual([
			{ id: created.id, created: created.expires - 7 * 86_400_000, expires: created.expires },
		]);
		// データベースにも、リンクに入れた値そのものは、ない。
		const row = await env.DB.prepare("SELECT hash FROM invites WHERE id = ?")
			.bind(created.id)
			.first<{ hash: string }>();
		expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.hash).not.toBe(created.token);
	});

	it("招待先を確かめられる。リンクから参加すると、メンバーになる(役割は member)", async () => {
		const { name, path, admin } = await project();
		const { token } = await invite(path, admin);
		const guest = await login();
		expect((await call(path, { as: guest })).status).toBe(404);

		const before = await call(`/api/invites/${token}`, { as: guest });
		const accepted = await send("POST", `/api/invites/${token}/accept`, guest);

		expect(await before.json()).toEqual({ project: name, member: false });
		expect(await accepted.json()).toEqual({ project: name, member: true });
		expect(await (await call(path, { as: guest })).json()).toEqual({
			name,
			visibility: "private",
			role: "member",
		});
		expect(await (await call(`/api/invites/${token}`, { as: guest })).json()).toEqual({
			project: name,
			member: true,
		});
		// 同じリンクで、ほかの人も参加できる。
		expect((await send("POST", `/api/invites/${token}/accept`, await login())).status).toBe(200);
	});

	it("ログインしていなくても、招待先は確かめられる。参加するには、ログインが要る", async () => {
		const { name, path, admin } = await project();
		const { token } = await invite(path, admin);

		expect(await (await call(`/api/invites/${token}`)).json()).toEqual({
			project: name,
			member: false,
		});
		const response = await send("POST", `/api/invites/${token}/accept`, undefined);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "login-required" });
	});

	it("もうメンバーの人が参加しても、役割は変わらない(管理者は、管理者のまま)", async () => {
		const { name, path, admin } = await project();
		const { token } = await invite(path, admin);

		expect((await send("POST", `/api/invites/${token}/accept`, admin)).status).toBe(200);

		expect(await (await call(path, { as: admin })).json()).toMatchObject({ name, role: "admin" });
		expect((await membersOf(path, admin)).members).toHaveLength(1);
	});

	it("無効にしたリンクは、使えない。一覧からも消える", async () => {
		const { path, admin } = await project();
		const { id, token } = await invite(path, admin);

		expect((await send("DELETE", `${path}/invites/${id}`, admin)).status).toBe(204);

		expect((await call(`/api/invites/${token}`)).status).toBe(404);
		const accepted = await send("POST", `/api/invites/${token}/accept`, await login());
		expect(accepted.status).toBe(404);
		expect(await accepted.json()).toEqual({ error: "unknown-invite" });
		expect((await membersOf(path, admin)).invites).toEqual([]);
		// もう無効なリンクを、もう一度無効にはできない。
		expect((await send("DELETE", `${path}/invites/${id}`, admin)).status).toBe(404);
	});

	it("期限の切れたリンクは、使えない。一覧からも消える", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const { path, admin } = await project();
		const { token } = await invite(path, admin);

		vi.setSystemTime(new Date("2026-01-07T23:59:59Z"));
		expect((await call(`/api/invites/${token}`)).status).toBe(200);
		vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));

		expect((await call(`/api/invites/${token}`)).status).toBe(404);
		expect((await send("POST", `/api/invites/${token}/accept`, admin)).status).toBe(404);
		expect((await membersOf(path, admin)).invites).toEqual([]);
	});

	it("でたらめな値のリンクは、使えない", async () => {
		expect((await call("/api/invites/unknown")).status).toBe(404);
	});

	it("ほかのプロジェクトの管理者は、リンクを無効にできない", async () => {
		const { path, admin } = await project();
		const other = await project();
		const { id, token } = await invite(path, admin);

		expect((await send("DELETE", `${other.path}/invites/${id}`, other.admin)).status).toBe(404);

		expect((await call(`/api/invites/${token}`)).status).toBe(200);
	});

	it("管理者でない人は、リンクを作ることも、無効にすることもできない。一覧にも出ない", async () => {
		const { path, admin } = await project("public");
		const { id } = await invite(path, admin);
		const joined = await member(path, admin);

		for (const as of [joined, await login(), undefined]) {
			expect((await send("POST", `${path}/invites`, as)).status).toBe(403);
			expect((await send("DELETE", `${path}/invites/${id}`, as)).status).toBe(403);
		}
		expect((await membersOf(path, joined)).invites).toEqual([]);
	});
});

describe("メンバー", () => {
	it("メンバーは、メンバーの一覧を見られる(参加した順。メールアドレスは含めない)", async () => {
		const { path, admin } = await project();
		const joined = await member(path, admin);

		const response = await call(`${path}/members`, { as: joined });

		const { members } = (await response.json()) as { members: Record<string, unknown>[] };
		expect(members).toEqual([
			{ id: admin.id, name: admin.name, picture: null, role: "admin", joined: expect.any(Number) },
			{
				id: joined.id,
				name: joined.name,
				picture: null,
				role: "member",
				joined: expect.any(Number),
			},
		]);
		expect(JSON.stringify(members)).not.toContain("@");
	});

	it("メンバーでない人は、公開のプロジェクトでも、メンバーの一覧を見られない", async () => {
		const { path } = await project("public");

		for (const as of [await login(), undefined]) {
			const response = await call(`${path}/members`, as ? { as } : {});
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "not-member" });
		}
	});

	it("管理者は、メンバーを管理者にできる。管理者を、メンバーに戻せる", async () => {
		const { path, admin } = await project();
		const joined = await member(path, admin);

		expect(
			(await send("PUT", `${path}/members/${joined.id}`, admin, { role: "admin" })).status,
		).toBe(204);
		expect(await (await call(path, { as: joined })).json()).toMatchObject({ role: "admin" });
		// 管理者になった人が、もとの管理者を、メンバーに戻す。
		expect(
			(await send("PUT", `${path}/members/${admin.id}`, joined, { role: "member" })).status,
		).toBe(204);
		expect(await (await call(path, { as: admin })).json()).toMatchObject({ role: "member" });
	});

	it("最後の管理者は、メンバーに戻せず、外せない(管理者のいないプロジェクトを、作らない)", async () => {
		const { path, admin } = await project();
		await member(path, admin);

		const demoted = await send("PUT", `${path}/members/${admin.id}`, admin, { role: "member" });
		const removed = await send("DELETE", `${path}/members/${admin.id}`, admin);

		expect(demoted.status).toBe(409);
		expect(await demoted.json()).toEqual({ error: "last-admin" });
		expect(removed.status).toBe(409);
		expect(await (await call(path, { as: admin })).json()).toMatchObject({ role: "admin" });
	});

	it("管理者は、メンバーを外せる。外された人は、非公開のプロジェクトを見られなくなる", async () => {
		const { path, admin } = await project();
		const joined = await member(path, admin);

		expect((await send("DELETE", `${path}/members/${joined.id}`, admin)).status).toBe(204);

		expect((await call(path, { as: joined })).status).toBe(404);
		expect((await call(`${path}/pages`, { as: joined })).status).toBe(404);
		expect((await membersOf(path, admin)).members.map((item) => item.id)).toEqual([admin.id]);
	});

	it("メンバーは、自分を外せる(抜ける)。ほかの人は外せない。役割も変えられない", async () => {
		const { path, admin } = await project();
		const joined = await member(path, admin);
		const other = await member(path, admin);

		const others = await send("DELETE", `${path}/members/${other.id}`, joined);
		const promoted = await send("PUT", `${path}/members/${joined.id}`, joined, { role: "admin" });

		expect(others.status).toBe(403);
		expect(await others.json()).toEqual({ error: "not-admin" });
		expect(promoted.status).toBe(403);
		expect((await send("DELETE", `${path}/members/${joined.id}`, joined)).status).toBe(204);
		expect((await membersOf(path, admin)).members.map((item) => item.id)).toEqual([
			admin.id,
			other.id,
		]);
	});

	it.each([
		["いないメンバーの役割を変える", "PUT", { role: "admin" }, 404, "unknown-member"],
		["いないメンバーを外す", "DELETE", undefined, 404, "unknown-member"],
	])("%sことは、できない", async (_name, method, body, status, error) => {
		const { path, admin } = await project();

		const response = await send(method, `${path}/members/nobody`, admin, body);

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
	});

	it("知らない役割には、変えられない", async () => {
		const { path, admin } = await project();

		const response = await send("PUT", `${path}/members/${admin.id}`, admin, { role: "owner" });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid-role" });
		expect((await send("PUT", `${path}/members/${admin.id}`, admin)).status).toBe(400);
	});
});

describe("権限がなくなった人の接続", () => {
	const title = { type: "insert", line: { id: "t", text: "題" }, after: null, before: null };

	/** ページを開き(台帳に載せ)、WebSocket でつなぐ。 */
	async function watch(path: string, as: Session, client: string) {
		const opened = await call(`${path}/pages/by-title/${encodeURIComponent("会議")}`, { as });
		const { id } = (await opened.json()) as { id: string };
		const response = await exports.default.fetch(
			`${ORIGIN}${path}/pages/${id}/socket?client=${client}`,
			{ headers: { Upgrade: "websocket", cookie: as.cookie } },
		);
		const socket = response.webSocket;
		if (!socket) throw new Error(`upgrade failed: ${response.status}`);
		socket.accept();
		const messages: { type: string }[] = [];
		const closes: number[] = [];
		socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(String(data))));
		socket.addEventListener("close", ({ code }) => closes.push(code));
		return { id, socket, messages, closes };
	}
	const commit = (path: string, id: string, as: Session, change: unknown = title) =>
		send("POST", `${path}/pages/${id}/commits`, as, { id: unique("c"), changes: [change] });
	const commits = (messages: { type: string }[]) =>
		messages.filter((message) => message.type === "commit");

	it("メンバーを外すと、その人がつないだままの接続には、そのあとの変更を配らず、接続を閉じる(ほかの人の接続は、そのまま)", async () => {
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		const staying = await member(path, admin);
		const removed = await watch(path, leaving, "leaving");
		const kept = await watch(path, staying, "staying");

		expect((await send("DELETE", `${path}/members/${leaving.id}`, admin)).status).toBe(204);
		expect((await commit(path, kept.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(commits(kept.messages)).toHaveLength(1));
		// 権限を確かめ直させるために、いったん閉じる(つなぎ直すと、断られる)。
		await vi.waitFor(() => expect(removed.closes).toEqual([4001]));
		expect(commits(removed.messages)).toEqual([]);
		const again = await call(`${path}/pages/${removed.id}/socket?client=leaving`, {
			as: leaving,
			headers: { Upgrade: "websocket" },
		});
		expect(again.status).toBe(404);
		kept.socket.close();
	});

	it("非公開に変えると、メンバーでない人の接続を閉じる。メンバーは、つなぎ直せば、続きを受け取れる", async () => {
		const { path, admin } = await project("public");
		const staying = await member(path, admin);
		const kept = await watch(path, staying, "staying");
		const viewer = await watch(path, await login(), "viewer");

		expect((await send("PATCH", path, admin, { visibility: "private" })).status).toBe(200);
		expect((await commit(path, kept.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(viewer.closes).toEqual([4001]));
		expect(commits(viewer.messages)).toEqual([]);
		// メンバーの接続は、そのまま。変更も届く。
		await vi.waitFor(() => expect(commits(kept.messages)).toHaveLength(1));
		expect(kept.closes).toEqual([]);
		kept.socket.close();
	});

	it("ログアウトすると、その人がつないだままの接続を閉じる(盗まれた Cookie でつないだ接続も、残さない)", async () => {
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		const open = await watch(path, leaving, "leaving");
		const kept = await watch(path, admin, "admin-1");

		expect((await send("POST", "/api/auth/logout", leaving)).status).toBe(204);
		expect((await commit(path, open.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(open.closes).toEqual([4001]));
		expect(commits(open.messages)).toEqual([]);
		expect(kept.closes).toEqual([]);
		kept.socket.close();
	});

	it("ログインの状態の期限が切れたあとは、つないだままの接続に、変更を配らず、接続を閉じる", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
		const { path, admin } = await project();
		const stale = await watch(path, await member(path, admin), "stale");

		// 31日たった。だれのログインの状態も、期限が切れている。管理者は、ログインし直す。
		vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
		const again = await login(admin.name);
		const fresh = await watch(path, again, "admin-2");
		expect((await commit(path, stale.id, again)).status).toBe(200);

		await vi.waitFor(() => expect(stale.closes).toEqual([4001]));
		expect(commits(stale.messages)).toEqual([]);
		// ログインし直してからつないだ接続は、そのまま。
		expect(fresh.closes).toEqual([]);
		fresh.socket.close();
	});

	/** プロジェクトのID(Durable Object の名前に使われる)。 */
	const projectId = async (path: string) =>
		(
			await env.DB.prepare("SELECT id FROM projects WHERE name = ?")
				.bind(path.slice("/api/projects/".length))
				.first<{ id: string }>()
		)?.id ?? "";

	/**
	 * 台帳のメソッドを、このプロジェクトの台帳でだけ、差し替える。
	 * 外から呼べるのは、クラスに定義したメソッドだけなので、クラスの側を差し替える。
	 */
	async function replace<Name extends "revocations" | "revoke" | "settle">(
		path: string,
		method: Name,
		/** proceed は、もとのメソッドを呼ぶ。 */
		replacement: (proceed: () => unknown) => unknown,
	) {
		const stub = exports.ProjectDO.getByName(await projectId(path));
		await runInDurableObject(stub, (instance) => {
			const prototype = Object.getPrototypeOf(instance);
			const original = prototype[method];
			vi.spyOn(prototype, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
				const proceed = () => original.apply(this, args);
				return this === instance ? replacement(proceed) : proceed();
			});
		});
	}

	it("リンクの書き換え(ページの名前を変えたとき)でも、権限のなくなった人の接続には配らない", async () => {
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		// だれもつないでいないうちに、リンクのあるページを書いておく。1行目は名前なので、リンクは2行目に書く。
		const opened = await call(`${path}/pages/by-title/${encodeURIComponent("会議")}`, {
			as: admin,
		});
		const page = (await opened.json()) as { id: string };
		const link = {
			type: "insert",
			line: { id: "b", text: "[旧い名前] を見る" },
			after: "t",
			before: null,
		};
		await send("POST", `${path}/pages/${page.id}/commits`, admin, {
			id: unique("c"),
			changes: [title, link],
		});
		const removed = await watch(path, leaving, "leaving");
		const kept = await watch(path, admin, "admin-1");

		expect((await send("DELETE", `${path}/members/${leaving.id}`, admin)).status).toBe(204);
		// 台帳が、リンクを書き換える(ふつうのコミットを通らない)。
		const stub = exports.PageDO.getByName(`${await projectId(path)}/${page.id}`);
		await stub.rewriteLinks([{ id: 1, from: "旧い名前", to: "新しい名前" }]);

		await vi.waitFor(() => expect(commits(kept.messages)).toHaveLength(1));
		await vi.waitFor(() => expect(removed.closes).toEqual([4001]));
		expect(commits(removed.messages)).toEqual([]);
		kept.socket.close();
	});

	it("権限を確かめたあと、接続を受け付けるまでのあいだに外された人の接続も、閉じる(確かめる前の時刻で、比べる)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.parse("2026-06-01T00:00:00Z");
		vi.setSystemTime(start);
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		const opened = await call(`${path}/pages/by-title/${encodeURIComponent("会議")}`, {
			as: admin,
		});
		const page = (await opened.json()) as { id: string };
		// 権限を確かめる問い合わせから、接続を受け付けるまでに、5秒かかる。
		let slowed = false;
		const slow = {
			...env,
			DB: {
				exec: (query: string) => env.DB.exec(query),
				batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
				prepare(query: string) {
					if (!slowed && query.includes("FROM projects p LEFT JOIN members")) {
						slowed = true;
						vi.setSystemTime(start + 5_000);
					}
					return env.DB.prepare(query);
				},
			} as D1Database,
		};
		const response = await app.request(
			`${ORIGIN}${path}/pages/${page.id}/socket?client=leaving`,
			{ headers: { Upgrade: "websocket", cookie: leaving.cookie } },
			slow,
		);
		const closes: number[] = [];
		const received: { type: string }[] = [];
		response.webSocket?.accept();
		response.webSocket?.addEventListener("close", ({ code }) => closes.push(code));
		response.webSocket?.addEventListener("message", ({ data }) =>
			received.push(JSON.parse(String(data))),
		);
		expect(slowed).toBe(true);

		// その5秒のあいだ(1秒後)に、外されていた。
		vi.setSystemTime(start + 1_000);
		expect((await send("DELETE", `${path}/members/${leaving.id}`, admin)).status).toBe(204);
		vi.setSystemTime(start + 6_000);
		expect((await commit(path, page.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(closes).toEqual([4001]));
		expect(commits(received)).toEqual([]);
	});

	it("同じ時刻(ミリ秒)に受け付けた接続も、閉じる", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		const removed = await watch(path, leaving, "leaving");

		// 時刻を進めずに、外す。
		expect((await send("DELETE", `${path}/members/${leaving.id}`, admin)).status).toBe(204);
		expect((await commit(path, removed.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(removed.closes).toEqual([4001]));
		expect(commits(removed.messages)).toEqual([]);
	});

	it("権限を取り上げた相手を、台帳に聞けなかったら、つないでいる接続をすべて閉じる(確かめられないまま、配らない)", async () => {
		const { path, admin } = await project();
		const other = await watch(path, await member(path, admin), "member-1");
		await replace(path, "revocations", () => {
			throw new Error("the directory is down");
		});

		// 保存は、止めない。
		expect((await commit(path, other.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(other.closes).toEqual([4001]));
		expect(commits(other.messages)).toEqual([]);
		// 台帳が戻れば、つなぎ直した接続に、ふつうに配る(失敗した結果を、覚えていない)。
		vi.restoreAllMocks();
		const again = await watch(path, admin, "admin-2");
		const change = { type: "update", id: "t", text: "題2" };
		expect((await commit(path, other.id, await member(path, admin), change)).status).toBe(200);
		await vi.waitFor(() => expect(commits(again.messages)).toHaveLength(1));
		expect(again.closes).toEqual([]);
		again.socket.close();
	});

	it("最後の管理者を外そうとして断られたときは、その人の接続を閉じない", async () => {
		const { path, admin } = await project();
		const own = await watch(path, admin, "admin-1");
		const other = await watch(path, await member(path, admin), "member-1");

		expect((await send("DELETE", `${path}/members/${admin.id}`, admin)).status).toBe(409);
		expect((await commit(path, own.id, await member(path, admin))).status).toBe(200);

		await vi.waitFor(() => expect(commits(own.messages)).toHaveLength(1));
		expect(own.closes).toEqual([]);
		expect(other.closes).toEqual([]);
		for (const { socket } of [own, other]) socket.close();
	});

	it("外せるかを確かめたあとで、ほかの管理者が抜けて、断ることになったときも、その人の接続を閉じない", async () => {
		const { path, admin } = await project();
		const second = await member(path, admin);
		await send("PUT", `${path}/members/${second.id}`, admin, { role: "admin" });
		const own = await watch(path, second, "second-1");
		const id = await projectId(path);
		// 台帳に覚えさせているあいだに、もう1人の管理者が抜ける。
		await replace(path, "revoke", async (proceed) => {
			await env.DB.prepare("DELETE FROM members WHERE project = ? AND user = ?")
				.bind(id, admin.id)
				.run();
			return proceed();
		});

		expect((await send("DELETE", `${path}/members/${second.id}`, second)).status).toBe(409);
		vi.restoreAllMocks();

		expect(await exports.ProjectDO.getByName(id).revocations()).toEqual([]);
		expect((await commit(path, own.id, second)).status).toBe(200);
		await vi.waitFor(() => expect(commits(own.messages)).toHaveLength(1));
		expect(own.closes).toEqual([]);
		own.socket.close();
	});

	it("取り上げている途中に、ページが台帳に聞いていても、断ったあとでつなぎ直した接続は、閉じない(途中の答えは、使い回さない)", async () => {
		const { path, admin } = await project();
		const second = await member(path, admin);
		await send("PUT", `${path}/members/${second.id}`, admin, { role: "admin" });
		const first = await watch(path, second, "second-1");
		const id = await projectId(path);
		// 台帳に覚えさせたあと、権限を変える前に、ページが台帳に聞く(コミットを配る)。そのあとで、もう1人の管理者が抜ける。
		await replace(path, "revoke", async (proceed) => {
			const operation = await proceed();
			expect((await commit(path, first.id, admin)).status).toBe(200);
			await env.DB.prepare("DELETE FROM members WHERE project = ? AND user = ?")
				.bind(id, admin.id)
				.run();
			return operation;
		});

		expect((await send("DELETE", `${path}/members/${second.id}`, second)).status).toBe(409);
		vi.restoreAllMocks();
		// 途中に聞かれたので、そのときの接続は、1度閉じられる(変える前に覚えさせる以上、避けられない)。
		await vi.waitFor(() => expect(first.closes).toEqual([4001]));

		const again = await watch(path, second, "second-2");
		const change = { type: "update", id: "t", text: "つなぎ直したあと" };
		expect((await commit(path, again.id, second, change)).status).toBe(200);

		await vi.waitFor(() => expect(commits(again.messages)).toHaveLength(1));
		expect(again.closes).toEqual([]);
		again.socket.close();
	});

	it("コミットがなくても、カーソルを配る前に、権限のなくなった人の接続を閉じる", async () => {
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		const removed = await watch(path, leaving, "leaving");
		const own = await watch(path, admin, "admin-1");

		expect((await send("DELETE", `${path}/members/${leaving.id}`, admin)).status).toBe(204);
		own.socket.send(JSON.stringify({ type: "cursor", cursor: { line: "t", column: 1 } }));

		await vi.waitFor(() => expect(removed.closes).toEqual([4001]));
		expect(removed.messages.filter((message) => message.type === "cursor")).toEqual([]);
		own.socket.close();
	});

	it("コミットの本文を送り終える前に外された人のコミットは、通さない(本文を待たせておいても、書き込めない)", async () => {
		const { path, admin } = await project();
		const leaving = await member(path, admin);
		const opened = await call(`${path}/pages/by-title/${encodeURIComponent("会議")}`, {
			as: admin,
		});
		const page = (await opened.json()) as { id: string };
		let finish: () => void = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				finish = () => {
					const commit = { id: unique("c"), changes: [title] };
					controller.enqueue(new TextEncoder().encode(JSON.stringify(commit)));
					controller.close();
				};
			},
		});
		const pending = app.request(
			`${ORIGIN}${path}/pages/${page.id}/commits`,
			{ method: "POST", headers: { cookie: leaving.cookie }, body, duplex: "half" } as RequestInit,
			env,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect((await send("DELETE", `${path}/members/${leaving.id}`, admin)).status).toBe(204);
		finish();

		expect((await pending).status).toBe(404);
		const saved = await call(`${path}/pages/${page.id}`, { as: admin });
		expect(await saved.json()).toMatchObject({ version: 0 });
	});

	it("管理者でなくなった人が、確かめを通ったあとの要求を送り終えても、役割は変わらない", async () => {
		const { path, admin } = await project();
		const demoted = await member(path, admin);
		await send("PUT", `${path}/members/${demoted.id}`, admin, { role: "admin" });
		// 本文を、あとから送る要求。権限は、本文を読む前に確かめられる。
		let finish: () => void = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				finish = () => {
					controller.enqueue(new TextEncoder().encode(JSON.stringify({ role: "admin" })));
					controller.close();
				};
			},
		});
		const pending = app.request(
			`${ORIGIN}${path}/members/${demoted.id}`,
			{ method: "PUT", headers: { cookie: demoted.cookie }, body, duplex: "half" } as RequestInit,
			env,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		// そのあいだに、もとの管理者が、メンバーに戻す。
		expect(
			(await send("PUT", `${path}/members/${demoted.id}`, admin, { role: "member" })).status,
		).toBe(204);
		finish();

		expect((await pending).status).toBe(403);
		expect(await (await call(path, { as: demoted })).json()).toMatchObject({ role: "member" });
	});

	it("権限を取り上げたことを、台帳に覚えさせられなかったら、権限も変えない(メンバーを外す、非公開にする)", async () => {
		const { path, admin } = await project("public");
		const leaving = await member(path, admin);
		await replace(path, "revoke", () => {
			throw new Error("the directory is down");
		});

		const removed = await send("DELETE", `${path}/members/${leaving.id}`, admin);
		const closed = await send("PATCH", path, admin, { visibility: "private" });

		expect(removed.status).toBe(500);
		expect(closed.status).toBe(500);
		vi.restoreAllMocks();
		expect((await membersOf(path, admin)).members.map((item) => item.id)).toContain(leaving.id);
		expect(await (await call(path)).json()).toMatchObject({ visibility: "public" });
	});

	it("権限を確かめているあいだに、ページが削除されたら、書き込まない", async () => {
		const { path, admin } = await project();
		// だれもつないでいないうちに、書いておく(このときは、台帳に聞かない)。
		const opened = await call(`${path}/pages/by-title/${encodeURIComponent("会議")}`, {
			as: admin,
		});
		const page = (await opened.json()) as { id: string };
		expect((await commit(path, page.id, admin)).status).toBe(200);
		const other = await watch(path, await member(path, admin), "member-1");
		const id = await projectId(path);
		await replace(path, "revocations", async () => {
			await exports.PageDO.getByName(`${id}/${other.id}`).destroy();
			return [];
		});

		const late = await commit(path, other.id, admin, {
			type: "update",
			id: "t",
			text: "遅れた変更",
		});

		expect(late.status).toBe(410);
		vi.restoreAllMocks();
		expect((await call(`${path}/pages/${other.id}`, { as: admin })).status).toBe(410);
	});

	it("権限を取り上げ終えたことを、台帳に覚えさせられなくても、変更は成り立つ。接続は、5分の余裕をもって閉じる", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
		const { path, admin } = await project("public");
		const leaving = await member(path, admin);
		await replace(path, "settle", () => {
			throw new Error("the directory is down");
		});

		const removed = await send("DELETE", `${path}/members/${leaving.id}`, admin);
		const closed = await send("PATCH", path, admin, { visibility: "private" });

		expect(removed.status).toBe(204);
		expect(closed.status).toBe(200);
		vi.restoreAllMocks();
		const at = Date.parse("2026-07-01T00:05:00Z");
		const stub = exports.ProjectDO.getByName(await projectId(path));
		expect(await stub.revocations()).toEqual([
			{ subject: "*", at, pending: true },
			{ subject: leaving.id, at, pending: true },
		]);
	});

	it("外されたあとで、もう一度招待されて参加した人の、新しい接続は閉じない", async () => {
		const { path, admin } = await project();
		const back = await member(path, admin);
		await send("DELETE", `${path}/members/${back.id}`, admin);
		const { token } = await invite(path, admin);
		await send("POST", `/api/invites/${token}/accept`, back);
		const rejoined = await watch(path, back, "back");

		expect((await commit(path, rejoined.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(commits(rejoined.messages)).toHaveLength(1));
		expect(rejoined.closes).toEqual([]);
		rejoined.socket.close();
	});

	it("権限を変えていなければ、接続は閉じない。公開に変えただけでも、閉じない", async () => {
		const { path, admin } = await project("private");
		const kept = await watch(path, admin, "admin-1");
		const other = await watch(path, await member(path, admin), "member-1");

		expect((await send("PATCH", path, admin, { visibility: "public" })).status).toBe(200);
		expect((await commit(path, kept.id, admin)).status).toBe(200);

		await vi.waitFor(() => expect(commits(other.messages)).toHaveLength(1));
		expect(other.closes).toEqual([]);
		expect(kept.closes).toEqual([]);
		for (const { socket } of [kept, other]) socket.close();
	});
});

describe("公開範囲を変える(PATCH /api/projects/:project)", () => {
	it("管理者は、公開にも、非公開にも変えられる", async () => {
		const { name, path, admin } = await project("private");
		const guest = await login();

		const opened = await send("PATCH", path, admin, { visibility: "public" });

		expect(await opened.json()).toEqual({ name, visibility: "public", role: "admin" });
		expect(await (await call(path, { as: guest })).json()).toEqual({
			name,
			visibility: "public",
			role: null,
		});
		expect((await send("PATCH", path, admin, { visibility: "private" })).status).toBe(200);
		expect((await call(path, { as: guest })).status).toBe(404);
	});

	it("管理者でない人は、変えられない", async () => {
		const { path, admin } = await project("public");
		const joined = await member(path, admin);

		for (const as of [joined, await login(), undefined]) {
			const response = await send("PATCH", path, as, { visibility: "private" });
			expect(response.status).toBe(403);
		}
		expect(await (await call(path)).json()).toMatchObject({ visibility: "public" });
	});

	it("知らない公開範囲には、変えられない", async () => {
		const { path, admin } = await project();

		const response = await send("PATCH", path, admin, { visibility: "secret" });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid-visibility" });
	});
});
