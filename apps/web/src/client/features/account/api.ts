import { type AccountState, parseAccountState } from "@amime/sync";

/** ログインの状態が分からないときの扱い。ログインしていないものとし、ログインの方法も出さない。 */
const UNKNOWN: AccountState = { user: null, login: [] };

/** ログインの状態を読む。読めなければ、ログインしていない扱いにする。 */
export async function loadAccount(): Promise<AccountState> {
	const response = await fetch("/api/me", undefined).catch(() => null);
	if (!response?.ok) return UNKNOWN;
	const parsed = parseAccountState(await response.json().catch(() => null));
	return parsed.ok ? parsed.value : UNKNOWN;
}

async function post(url: string, init: RequestInit): Promise<boolean> {
	const response = await fetch(url, init).catch(() => null);
	return response?.ok ?? false;
}

/** ログアウトする。成功したかを返す。 */
export const logout = (): Promise<boolean> => post("/api/auth/logout", { method: "POST" });

/** 開発用のログイン(手元での開発と自動テストでだけ使える)。成功したかを返す。 */
export const devLogin = (name: string): Promise<boolean> =>
	post("/api/auth/dev", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});

/** 表示名とアイコンを変えられなかった理由。 */
export type ProfileError = "invalid-name" | "invalid-picture" | "failed";

/**
 * 表示名とアイコンを変える(ADR-0035)。picture の null は、アイコンをなくす。
 * 成功なら null、失敗なら理由。
 */
export async function updateProfile(profile: {
	readonly name: string;
	readonly picture: string | null;
}): Promise<ProfileError | null> {
	const response = await fetch("/api/me", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(profile),
	}).catch(() => null);
	if (response?.ok) return null;
	const body: unknown = await response?.json().catch(() => null);
	const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
	return error === "invalid-name" || error === "invalid-picture" ? error : "failed";
}

/** ログインを始めるリンク。ログインのあと、returnTo(このサイトの中のパス)へ戻る。 */
export const loginHref = (method: "google", returnTo: string): string =>
	`/api/auth/login/${method}?return=${encodeURIComponent(returnTo)}`;
