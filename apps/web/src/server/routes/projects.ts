import { allows, canCreateProject, parseProjectName, type Visibility } from "@amime/shared";
import type { ProjectInfo, ProjectList } from "@amime/sync";
import { Hono } from "hono";
import { type AppEnv, readJson } from "../context.ts";
import { createProject, findProject, listProjects } from "../db/projects.ts";
import { icons } from "./icons.ts";
import { members } from "./members.ts";
import { pages } from "./pages.ts";

const VISIBILITIES: ReadonlySet<unknown> = new Set<Visibility>(["public", "private"]);

/** プロジェクトを新しく作ってよい人の設定。シークレットで渡す(設定がなければ、誰も作れない)。 */
const creators = (env: Cloudflare.Env): string | undefined => env.PROJECT_CREATORS;

/** プロジェクトの下のAPI。読める人(メンバーか、公開のプロジェクトを見る人)だけを通す。 */
const inProject = new Hono<AppEnv>()
	.use(async (c, next) => {
		// 名前の形が違えば、探すまでもない。大文字で書かれた名前は、小文字にそろえて探す。
		const name = parseProjectName(c.req.param("project"));
		const project = name.ok
			? await findProject(c.env.DB, name.value, c.var.user?.id ?? null)
			: null;
		// ないプロジェクトと、見られないプロジェクトを、同じ応答にする(あることを、知らせない)。
		if (project === null || !allows(project.role, project.visibility, "read")) {
			return c.json({ error: "unknown-project" }, 404);
		}
		c.set("project", project);
		return next();
	})
	.get("/", (c) => {
		const { name, visibility, role } = c.var.project;
		return c.json({ name, visibility, role } satisfies ProjectInfo);
	})
	.route("/pages", pages)
	.route("/icons", icons)
	.route("/", members);

/** プロジェクト(ADR-0033)。 */
export const projects = new Hono<AppEnv>()
	// 参加しているプロジェクトの一覧。ログインしていなければ、空。
	.get("/", async (c) => {
		const user = c.var.user;
		const list: ProjectList =
			user === null
				? { projects: [], canCreate: false }
				: {
						projects: await listProjects(c.env.DB, user.id),
						canCreate: canCreateProject(creators(c.env), user.email),
					};
		return c.json(list);
	})
	// プロジェクトを作る。作った人が、管理者になる。
	.post("/", async (c) => {
		const user = c.var.user;
		if (user === null) return c.json({ error: "login-required" }, 401);
		if (!canCreateProject(creators(c.env), user.email)) {
			return c.json({ error: "not-allowed" }, 403);
		}
		const body = await readJson(c.req.raw);
		const input: Record<string, unknown> =
			typeof body === "object" && body !== null ? { ...body } : {};
		const name = parseProjectName(input["name"]);
		if (!name.ok) return c.json({ error: `${name.error}-name` }, 400);
		const visibility = input["visibility"] ?? "private";
		if (!VISIBILITIES.has(visibility)) return c.json({ error: "invalid-visibility" }, 400);
		const project = { name: name.value, visibility: visibility as Visibility };
		const created = await createProject(c.env.DB, project, user.id, Date.now());
		if (!created) return c.json({ error: "name-taken" }, 409);
		return c.json({ ...project, role: "admin" } satisfies ProjectInfo, 201);
	})
	.route("/:project", inProject);
