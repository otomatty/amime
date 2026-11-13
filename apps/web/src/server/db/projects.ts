import type { Role, Visibility } from "@amime/shared";
import type { ProjectInfo, UserId } from "@amime/sync";
import { randomToken } from "../auth/crypto.ts";
import type { ProjectAccess } from "../context.ts";

/**
 * 名前からプロジェクトを引き、その人の役割を添えて返す。なければ null。
 * user は、ログインしている利用者のID(していなければ null)。
 */
export async function findProject(
	db: D1Database,
	name: string,
	user: UserId | null,
): Promise<ProjectAccess | null> {
	return db
		.prepare(
			`SELECT p.id, p.name, p.visibility, m.role
			FROM projects p LEFT JOIN members m ON m.project = p.id AND m.user = ?
			WHERE p.name = ?`,
		)
		.bind(user, name)
		.first<ProjectAccess>();
}

/** その人が参加しているプロジェクトを、名前の順に返す。 */
export async function listProjects(db: D1Database, user: UserId): Promise<ProjectInfo[]> {
	const { results } = await db
		.prepare(
			`SELECT p.name, p.visibility, m.role
			FROM members m JOIN projects p ON p.id = m.project
			WHERE m.user = ? ORDER BY p.name`,
		)
		.bind(user)
		.all<{ name: string; visibility: Visibility; role: Role }>();
	return results;
}

/**
 * プロジェクトを作り、作った人を管理者にする。同じ名前のプロジェクトがあれば、作らない(false)。
 */
export async function createProject(
	db: D1Database,
	project: { readonly name: string; readonly visibility: Visibility },
	user: UserId,
	now: number,
): Promise<boolean> {
	const id = randomToken(16);
	// 2つの文を、まとめて実行する。管理者のいないプロジェクトを、残さない。
	const [created] = await db.batch([
		db
			.prepare(
				`INSERT INTO projects (id, name, visibility, created, created_by)
				VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`,
			)
			.bind(id, project.name, project.visibility, now, user),
		// プロジェクトを作れたときだけ(このIDの行があるときだけ)、管理者にする。
		db
			.prepare(
				`INSERT INTO members (project, user, role, joined)
				SELECT ?, ?, 'admin', ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)`,
			)
			.bind(id, user, now, id),
	]);
	return created?.meta.changes === 1;
}
