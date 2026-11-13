import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acceptInvite,
	createInvite,
	createProject,
	listProjects,
	loadInvite,
	loadMembers,
	loadProject,
	removeMember,
	revokeInvite,
	setRole,
	setVisibility,
} from "./api.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const stubFetch = (reply: () => Promise<Response> | Response) => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply());
	vi.stubGlobal("fetch", fetch);
	return fetch;
};
const team = { name: "team", visibility: "private", role: "admin" };

describe("loadProject(名前からプロジェクトを引く)", () => {
	it("プロジェクトと、見ている人の役割を返す", async () => {
		const fetch = stubFetch(() => Response.json(team));

		expect(await loadProject("team")).toEqual({ status: "ready", project: team });
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects/team", undefined);
	});

	it("ない(見る権限がない)プロジェクトは、missing", async () => {
		stubFetch(() => Response.json({ error: "unknown-project" }, { status: 404 }));

		expect(await loadProject("team")).toEqual({ status: "missing" });
	});

	it.each([
		["通信できない", () => Promise.reject(new Error("network"))],
		["サーバーが失敗を返した", () => new Response("x", { status: 500 })],
		["形の違う応答が返った", () => Response.json({ name: "team" })],
		["JSONでない応答が返った", () => new Response("<html>")],
	])("%sときは、failed", async (_name, reply) => {
		stubFetch(reply);

		expect(await loadProject("team")).toEqual({ status: "failed" });
	});
});

describe("listProjects(参加しているプロジェクトの一覧)", () => {
	it("一覧と、新しく作れるかどうかを返す", async () => {
		const list = { projects: [team], canCreate: true };
		const fetch = stubFetch(() => Response.json(list));

		expect(await listProjects()).toEqual(list);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects", undefined);
	});

	it.each([
		["通信できない", () => Promise.reject(new Error("network"))],
		["サーバーが失敗を返した", () => new Response("x", { status: 500 })],
		["形の違う応答が返った", () => Response.json({ projects: "x" })],
	])("%sときは、null", async (_name, reply) => {
		stubFetch(reply);

		expect(await listProjects()).toBeNull();
	});
});

describe("createProject(プロジェクトを作る)", () => {
	it("名前と公開範囲を送り、作ったプロジェクトを返す", async () => {
		const fetch = stubFetch(() => Response.json(team, { status: 201 }));

		expect(await createProject("team", "private")).toEqual({ ok: true, project: team });
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "team", visibility: "private" }),
		});
	});

	it.each(["invalid-name", "reserved-name", "name-taken", "not-allowed", "login-required"])(
		"サーバーが断った理由(%s)を返す",
		async (error) => {
			stubFetch(() => Response.json({ error }, { status: 400 }));

			expect(await createProject("team", "public")).toEqual({ ok: false, error });
		},
	);

	it.each([
		["通信できない", () => Promise.reject(new Error("network"))],
		["知らない理由で断られた", () => Response.json({ error: "x" }, { status: 400 })],
		["理由のない失敗", () => new Response("x", { status: 500 })],
		["成功したが、形の違う応答が返った", () => Response.json({ ok: true }, { status: 201 })],
	])("%sときは、failed", async (_name, reply) => {
		stubFetch(reply);

		expect(await createProject("team", "public")).toEqual({ ok: false, error: "failed" });
	});
});

describe("メンバーと招待リンク", () => {
	const members = {
		members: [{ id: "u1", name: "花子", picture: null, role: "admin", joined: 1 }],
		invites: [],
	};

	it("loadMembers: メンバーと招待リンクの一覧を返す。読めなければ null", async () => {
		const fetch = stubFetch(() => Response.json(members));
		expect(await loadMembers("team")).toEqual(members);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects/team/members", undefined);

		stubFetch(() => Response.json({ error: "not-member" }, { status: 403 }));
		expect(await loadMembers("team")).toBeNull();
		stubFetch(() => Response.json({ members: "x" }));
		expect(await loadMembers("team")).toBeNull();
	});

	it.each([
		[
			"setVisibility",
			() => setVisibility("team", "public"),
			"/api/projects/team",
			"PATCH",
			{ visibility: "public" },
		],
		[
			"setRole",
			() => setRole("team", "u2" as never, "admin"),
			"/api/projects/team/members/u2",
			"PUT",
			{ role: "admin" },
		],
		[
			"removeMember",
			() => removeMember("team", "u2" as never),
			"/api/projects/team/members/u2",
			"DELETE",
			undefined,
		],
		[
			"revokeInvite",
			() => revokeInvite("team", "i1"),
			"/api/projects/team/invites/i1",
			"DELETE",
			undefined,
		],
	] as const)("%s: 変える操作を送る。成功なら null", async (_name, run, url, method, body) => {
		const fetch = stubFetch(() => new Response(null, { status: 204 }));

		expect(await run()).toBeNull();
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			url,
			body === undefined
				? { method }
				: { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		);
	});

	it.each([
		[
			"サーバーが断った理由",
			() => Response.json({ error: "last-admin" }, { status: 409 }),
			"last-admin",
		],
		["理由のない失敗", () => new Response("x", { status: 500 }), "failed"],
		["理由が文字列でない", () => Response.json({ error: 1 }, { status: 400 }), "failed"],
		["通信できない", () => Promise.reject(new Error("network")), "failed"],
	])("変える操作が失敗したら、理由を返す(%s)", async (_name, reply, reason) => {
		stubFetch(reply);

		expect(await removeMember("team", "u2" as never)).toBe(reason);
	});

	it("createInvite: 作った招待リンクを返す。作れなければ null", async () => {
		const created = { id: "i1", created: 1, expires: 2, token: "tok" };
		const fetch = stubFetch(() => Response.json(created, { status: 201 }));
		expect(await createInvite("team")).toEqual(created);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/projects/team/invites", { method: "POST" });

		stubFetch(() => Response.json({ error: "not-admin" }, { status: 403 }));
		expect(await createInvite("team")).toBeNull();
		stubFetch(() => Response.json({ id: "i1" }, { status: 201 }));
		expect(await createInvite("team")).toBeNull();
	});

	it("loadInvite / acceptInvite: 招待先を返す", async () => {
		const target = { project: "team", member: false };
		const fetch = stubFetch(() => Response.json(target));

		expect(await loadInvite("tok")).toEqual({ status: "ready", invite: target });
		expect(await acceptInvite("tok")).toEqual({ status: "ready", invite: target });
		expect(fetch.mock.calls).toEqual([
			["/api/invites/tok", undefined],
			["/api/invites/tok/accept", { method: "POST" }],
		]);
	});

	it.each([
		[
			"使えないリンク",
			() => Response.json({ error: "unknown-invite" }, { status: 404 }),
			"missing",
		],
		["サーバーの失敗", () => new Response("x", { status: 500 }), "failed"],
		["形の違う応答", () => Response.json({ project: 1 }), "failed"],
		["通信できない", () => Promise.reject(new Error("network")), "failed"],
	])("loadInvite / acceptInvite: %sは、%s", async (_name, reply, status) => {
		stubFetch(reply);

		expect(await loadInvite("tok")).toEqual({ status });
		expect(await acceptInvite("tok")).toEqual({ status });
	});
});
