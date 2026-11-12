import type { ClientId } from "@amime/sync";

/** この端末(タブ)の識別子を作る。ページを開くたびに新しく作る。 */
export function createClientId(): ClientId {
	// ブランド型の生成。形は、サーバーの検査(parseClientId)が受け付けるものにする。
	return crypto.randomUUID() as ClientId;
}
