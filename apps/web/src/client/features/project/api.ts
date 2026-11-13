import type { Role, Visibility } from "@amime/shared";
import {
	type InviteTarget,
	type NewInvite,
	type ProjectInfo,
	type ProjectList,
	type ProjectMembers,
	parseInviteTarget,
	parseNewInvite,
	parseProjectInfo,
	parseProjectList,
	parseProjectMembers,
	type UserId,
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

const JSON_HEADERS = { "content-type": "application/json" };
const projectPath = (project: string): string => `/api/projects/${encodeURIComponent(project)}`;

/** サーバーが断った理由(応答の error)。読めなければ "failed"。 */
async function errorOf(response: Response | null): Promise<string> {
	const body: unknown = await response?.json().catch(() => null);
	const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
	return typeof error === "string" ? error : "failed";
}

/** 変える操作を送る。成功なら null、失敗なら、サーバーが断った理由。 */
async function change(url: string, method: string, body?: unknown): Promise<string | null> {
	const init =
		body === undefined ? { method } : { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
	const response = await fetch(url, init).catch(() => null);
	return response?.ok ? null : errorOf(response);
}

/** メンバーと、まだ使える招待リンクの一覧。読めなければ null。 */
export async function loadMembers(project: string): Promise<ProjectMembers | null> {
	const response = await fetch(`${projectPath(project)}/members`, undefined).catch(() => null);
	if (!response?.ok) return null;
	const parsed = parseProjectMembers(await response.json().catch(() => null));
	return parsed.ok ? parsed.value : null;
}

/** 公開範囲を変える。成功なら null、失敗なら理由。 */
export const setVisibility = (project: string, visibility: Visibility): Promise<string | null> =>
	change(projectPath(project), "PATCH", { visibility });

/** メンバーの役割を変える。成功なら null、失敗なら理由(last-admin など)。 */
export const setRole = (project: string, user: UserId, role: Role): Promise<string | null> =>
	change(`${projectPath(project)}/members/${user}`, "PUT", { role });

/** メンバーを外す(自分を指せば、抜ける)。成功なら null、失敗なら理由。 */
export const removeMember = (project: string, user: UserId): Promise<string | null> =>
	change(`${projectPath(project)}/members/${user}`, "DELETE");

/** 招待リンクを作る。リンクに入れる値(token)は、ここでしか分からない。作れなければ null。 */
export async function createInvite(project: string): Promise<NewInvite | null> {
	const response = await fetch(`${projectPath(project)}/invites`, { method: "POST" }).catch(
		() => null,
	);
	if (!response?.ok) return null;
	const parsed = parseNewInvite(await response.json().catch(() => null));
	return parsed.ok ? parsed.value : null;
}

/** 招待リンクを無効にする。成功なら null、失敗なら理由。 */
export const revokeInvite = (project: string, id: string): Promise<string | null> =>
	change(`${projectPath(project)}/invites/${encodeURIComponent(id)}`, "DELETE");

/** 招待リンクを確かめた結果。missing は、使えないリンク(ない、無効、期限切れ)。 */
export type LoadedInvite =
	| { readonly status: "ready"; readonly invite: InviteTarget }
	| { readonly status: "missing" }
	| { readonly status: "failed" };

async function inviteResult(response: Response | null): Promise<LoadedInvite> {
	if (response?.status === STATUS_MISSING) return { status: "missing" };
	if (!response?.ok) return { status: "failed" };
	const parsed = parseInviteTarget(await response.json().catch(() => null));
	return parsed.ok ? { status: "ready", invite: parsed.value } : { status: "failed" };
}

/** 招待リンクの招待先を確かめる。 */
export const loadInvite = async (token: string): Promise<LoadedInvite> =>
	inviteResult(
		await fetch(`/api/invites/${encodeURIComponent(token)}`, undefined).catch(() => null),
	);

/** 招待リンクで、プロジェクトに参加する。 */
export const acceptInvite = async (token: string): Promise<LoadedInvite> =>
	inviteResult(
		await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" }).catch(
			() => null,
		),
	);
