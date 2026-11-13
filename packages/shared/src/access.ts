import { err, ok, type Result } from "./result.ts";

/** プロジェクトでの役割。admin は、設定とメンバーを変えられる。 */
export type Role = "admin" | "member";
/** プロジェクトの公開範囲。public は、誰でも読める(書けるのは、メンバーだけ)。 */
export type Visibility = "public" | "private";
/** プロジェクトでの操作。 */
export type Action = "read" | "write" | "manage";

/**
 * プロジェクトで、その操作をしてよいか(ADR-0033)。
 * role は、その人の役割。メンバーでなければ(ログインしていない人も) null。
 */
export function allows(role: Role | null, visibility: Visibility, action: Action): boolean {
	if (action === "read") return role !== null || visibility === "public";
	return action === "write" ? role !== null : role === "admin";
}

/** プロジェクトの名前の長さ。 */
const MIN_PROJECT_NAME = 2;
const MAX_PROJECT_NAME = 40;
/** 小文字の英数字を、1つずつのハイフンでつないだ形。 */
const PROJECT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** アプリが使うパスの最初の部分。プロジェクトの名前にすると、URLが重なる。 */
const RESERVED: ReadonlySet<string> = new Set([
	"api",
	"assets",
	"settings",
	"invite",
	"new",
	"login",
	"logout",
	"projects",
]);

/**
 * プロジェクトの名前を検査する。名前は、URLの最初の部分になる(/名前/ページ)。
 * 小文字の英数字とハイフンで、2文字から40文字まで。大文字は、小文字にそろえる。
 */
export function parseProjectName(value: unknown): Result<string, "invalid" | "reserved"> {
	if (typeof value !== "string") return err("invalid");
	const name = value.toLowerCase();
	if (name.length < MIN_PROJECT_NAME || name.length > MAX_PROJECT_NAME) return err("invalid");
	if (!PROJECT_NAME.test(name)) return err("invalid");
	return RESERVED.has(name) ? err("reserved") : ok(name);
}

/**
 * プロジェクトを新しく作ってよい人か(ADR-0009: 作れる人を制限する)。
 * setting は、作れる人のメールアドレスをカンマで並べたもの。「*」なら、ログインしていれば誰でも作れる。
 * 設定がなければ、誰も作れない。
 */
export function canCreateProject(setting: string | undefined, email: string): boolean {
	const allowed = (setting ?? "").split(",").map((item) => item.trim().toLowerCase());
	return allowed.includes("*") || (email !== "" && allowed.includes(email.toLowerCase()));
}
