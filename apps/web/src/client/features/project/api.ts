import type { Visibility } from "@amime/shared";
import {
	type ProjectInfo,
	type ProjectList,
	parseProjectInfo,
	parseProjectList,
} from "@amime/sync";

const STATUS_MISSING = 404;

/** プロジェクトを読み込んだ結果。missing は、ないか、見る権限がない(サーバーは、区別して返さない)。 */
export type LoadedProject =
	| { readonly status: "ready"; readonly project: ProjectInfo }
	| { readonly status: "missing" }
	| { readonly status: "failed" };

/** 名前からプロジェクトを引く。見ている人の役割も、一緒に返る。 */
export async function loadProject(name: string): Promise<LoadedProject> {
	const response = await fetch(`/api/projects/${encodeURIComponent(name)}`, undefined).catch(
		() => null,
	);
	if (response?.status === STATUS_MISSING) return { status: "missing" };
	if (!response?.ok) return { status: "failed" };
	const parsed = parseProjectInfo(await response.json().catch(() => null));
	return parsed.ok ? { status: "ready", project: parsed.value } : { status: "failed" };
}

/** 参加しているプロジェクトの一覧。読めなければ null。 */
export async function listProjects(): Promise<ProjectList | null> {
	const response = await fetch("/api/projects", undefined).catch(() => null);
	if (!response?.ok) return null;
	const parsed = parseProjectList(await response.json().catch(() => null));
	return parsed.ok ? parsed.value : null;
}

/** プロジェクトを作れなかった理由。 */
export type CreateProjectError =
	| "invalid-name"
	| "reserved-name"
	| "name-taken"
	| "not-allowed"
	| "login-required"
	| "failed";

const CREATE_ERRORS: ReadonlySet<string> = new Set<CreateProjectError>([
	"invalid-name",
	"reserved-name",
	"name-taken",
	"not-allowed",
	"login-required",
]);

/** プロジェクトを作る。作った人が、管理者になる。 */
export async function createProject(
	name: string,
	visibility: Visibility,
): Promise<
	| { readonly ok: true; readonly project: ProjectInfo }
	| { readonly ok: false; readonly error: CreateProjectError }
> {
	const response = await fetch("/api/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, visibility }),
	}).catch(() => null);
	const body: unknown = await response?.json().catch(() => null);
	if (response?.ok) {
		const parsed = parseProjectInfo(body);
		return parsed.ok ? { ok: true, project: parsed.value } : { ok: false, error: "failed" };
	}
	const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
	return {
		ok: false,
		error:
			typeof error === "string" && CREATE_ERRORS.has(error)
				? (error as CreateProjectError)
				: "failed",
	};
}
