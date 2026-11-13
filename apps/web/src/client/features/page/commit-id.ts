import type { CommitId } from "@amime/sync";

/** コミットのIDを作る。送り直しても同じコミットだと分かるように、コミットごとに1つ作る(ADR-0021)。 */
export function createCommitId(): CommitId {
	// ブランド型の生成。形は、サーバーの検査が受け付けるものにする。
	return crypto.randomUUID() as CommitId;
}

/** 内容から決めるIDに使う、ハッシュの長さ(16進の文字数)。IDは64文字までなので、番号を付けても収まる長さにする。 */
const DIGEST_LENGTH = 40;

/**
 * 内容(source)と番号(part)から、コミットのIDを決める。同じ内容と番号からは、いつも同じIDになる。
 *
 * 端末内に残してあった「まだ送っていなかった変更」を、復元のときにコミットとして送るのに使う。
 * 送る前にIDを残しておく場所がないので、内容から決める。復元を途中からやり直しても、
 * 同じコミットとして送り直せる(サーバーは、1度しか適用しない)。
 */
export async function deriveCommitId(source: string, part: number): Promise<CommitId> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
	// ブランド型の生成。形は、サーバーの検査が受け付けるものにする。
	return `r-${hex.join("").slice(0, DIGEST_LENGTH)}-${part}` as CommitId;
}
