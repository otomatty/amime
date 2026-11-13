import type { Role, Visibility } from "@amime/shared";
import type { Account } from "@amime/sync";

/** 要求の宛先のプロジェクトと、要求した人の、そこでの役割(メンバーでなければ null)。 */
export type ProjectAccess = {
	/** 変わらないID。Durable Object の名前に使う。 */
	readonly id: string;
	readonly name: string;
	readonly visibility: Visibility;
	readonly role: Role | null;
};

/**
 * API の処理に渡るもの。
 * user は、ログインしている利用者(していなければ null)。
 * project は、プロジェクトの下のAPIでだけ入る(読めることを確かめたもの)。
 */
export type AppEnv = {
	Bindings: Cloudflare.Env;
	Variables: { user: Account | null; project: ProjectAccess };
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
