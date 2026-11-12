import { type Line, type PageSnapshot, type PendingEntry, withPending } from "@amime/sync";
import { PageApiError } from "./page-api-error.ts";
import type { PageApi } from "./page-sync.ts";

type Restored = {
	readonly snapshot: PageSnapshot;
	/** 前回送れなかった変更を載せた文書。載せるものがなければ null。 */
	readonly restored: readonly Line[] | null;
	/** 前回送れなかった変更を復元したか(画面に伝えるかどうか)。 */
	readonly noticed: boolean;
};

/**
 * ページを開く。端末内に、前回送れなかった変更が残っていたら、復元する(ADR-0020、ADR-0021)。
 *
 * 1. 閉じたタブが残した変更を引き取る。
 * 2. 閉じたタブが送信中だったコミットを、同じIDで送り直す。サーバーに入っていたら、何も起きない。
 * 3. ページを読み込む(送り直したコミットは、もう含まれている)。
 * 4. まだ送っていなかった変更を、読み込んだページに載せる。
 */
export async function restorePage(
	api: Pick<PageApi, "load" | "commit">,
	pending: { readonly adopt: () => Promise<readonly PendingEntry[]> },
): Promise<Restored> {
	const entries = await pending.adopt();

	let resent = false;
	for (const { inflight } of entries) {
		if (inflight === null) continue;
		try {
			const result = await api.commit(inflight);
			resent = resent || result.applied.length > 0;
		} catch (error) {
			// 断られたコミットは、送り直しても通らない。飛ばして、残りを復元する。
			if (!(error instanceof PageApiError && error.kind === "rejected")) throw error;
		}
	}

	const snapshot = await api.load();
	const document = withPending(
		snapshot.lines,
		entries.map((entry) => entry.changes),
	);
	const restored = document === snapshot.lines ? null : document;
	return { snapshot, restored, noticed: resent || restored !== null };
}
