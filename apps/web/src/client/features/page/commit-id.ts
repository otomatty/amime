import type { CommitId } from "@amime/sync";

/** コミットのIDを作る。送り直しても同じコミットだと分かるように、コミットごとに1つ作る(ADR-0021)。 */
export function createCommitId(): CommitId {
	// ブランド型の生成。形は、サーバーの検査が受け付けるものにする。
	return crypto.randomUUID() as CommitId;
}
