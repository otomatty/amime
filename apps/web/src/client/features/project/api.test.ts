import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, listProjects, loadProject } from "./api.ts";

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
