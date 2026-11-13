import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { signIn } from "../auth/accounts.ts";
import { ready } from "./migrate.ts";
import { createProject, findProject, listProjectIds, listProjects } from "./projects.ts";

const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;
const user = (name = unique("db-user")) =>
	signIn(
		env.DB,
		"dev",
		{ subject: name, email: `${name}@dev.invalid`, name, picture: null },
		1_000,
	);

beforeAll(() => ready(env.DB));

describe("createProject / findProject", () => {
	it("作った人を管理者にする。ほかの人から見ると、役割はない", async () => {
		const [admin, other] = [await user(), await user()];
		const name = unique("db-team");

		expect(await createProject(env.DB, { name, visibility: "private" }, admin, 2_000)).toBe(true);

		const seen = await findProject(env.DB, name, admin);
		expect(seen).toEqual({
			id: expect.stringMatching(/^[\w-]{22}$/),
			name,
			visibility: "private",
			role: "admin",
		});
		expect(await findProject(env.DB, name, other)).toEqual({ ...seen, role: null });
		expect(await findProject(env.DB, name, null)).toEqual({ ...seen, role: null });
	});

	it("同じ名前では作れない。あとから作ろうとした人は、メンバーにならない", async () => {
		const [first, second] = [await user(), await user()];
		const name = unique("db-taken");
		await createProject(env.DB, { name, visibility: "public" }, first, 2_000);

		expect(await createProject(env.DB, { name, visibility: "private" }, second, 3_000)).toBe(false);

		expect(await findProject(env.DB, name, second)).toMatchObject({
			visibility: "public",
			role: null,
		});
		expect(await listProjects(env.DB, second)).toEqual([]);
	});

	it("ないプロジェクトは null", async () => {
		expect(await findProject(env.DB, unique("db-none"), null)).toBeNull();
	});
});

describe("listProjectIds", () => {
	it("参加しているプロジェクトのIDを返す", async () => {
		const [me, other] = [await user(), await user()];
		const name = unique("db-ids");
		await createProject(env.DB, { name, visibility: "private" }, me, 2_000);
		await createProject(
			env.DB,
			{ name: unique("db-ids-other"), visibility: "public" },
			other,
			2_000,
		);

		const found = await findProject(env.DB, name, me);
		expect(await listProjectIds(env.DB, me)).toEqual([found?.id]);
	});
});

describe("listProjects", () => {
	it("参加しているプロジェクトを、名前の順に返す", async () => {
		const [me, other] = [await user(), await user()];
		const [b, a] = [unique("db-b"), unique("db-a")];
		await createProject(env.DB, { name: b, visibility: "public" }, me, 2_000);
		await createProject(env.DB, { name: a, visibility: "private" }, me, 2_000);
		await createProject(env.DB, { name: unique("db-other"), visibility: "public" }, other, 2_000);

		expect(await listProjects(env.DB, me)).toEqual([
			{ name: a, visibility: "private", role: "admin" },
			{ name: b, visibility: "public", role: "admin" },
		]);
	});
});
