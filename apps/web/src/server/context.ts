import type { Account } from "@amime/sync";

/** API の処理に渡るもの。user は、ログインしている利用者(していなければ null)。 */
export type AppEnv = {
	Bindings: Cloudflare.Env;
	Variables: { user: Account | null };
};

/** Origin ヘッダーの指すサイトが、要求を受けたこのサイトと同じか(スキーム・ホスト・ポートがすべて同じ)。 */
export function sameSite(origin: string, url: string): boolean {
	try {
		return new URL(origin).origin === new URL(url).origin;
	} catch {
		return false;
	}
}

/** 本文をJSONとして読む。読めなければ null。 */
export async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}
