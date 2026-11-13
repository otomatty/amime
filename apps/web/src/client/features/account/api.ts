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

/** ログインを始めるリンク。ログインのあと、returnTo(このサイトの中のパス)へ戻る。 */
export const loginHref = (method: "google", returnTo: string): string =>
	`/api/auth/login/${method}?return=${encodeURIComponent(returnTo)}`;
