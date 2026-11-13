import {
	type Change,
	type Commit,
	type Line,
	type PageSnapshot,
	type PendingEntry,
	sameLines,
	splitChanges,
	withPending,
} from "@amime/sync";
import { deriveCommitId } from "./commit-id.ts";
import { PageApiError } from "./page-api-error.ts";
import type { PageApi } from "./page-sync.ts";

type Restored = {
	readonly snapshot: PageSnapshot;
	/** 前回送れなかった変更を載せた文書。載せるものがなければ null。 */
	readonly restored: readonly Line[] | null;
	/** 前回送れなかった変更を復元したか(画面に伝えるかどうか)。 */
	readonly noticed: boolean;
};

/** サーバーに入れようとしたコミットの行方。 */
type Outcome = "applied" | "ineffective" | "rejected";

/**
 * コミットをサーバーに入れる。以前に入っていたコミットなら、何も起きない(ADR-0021)。
 * サーバーに断られたら rejected。通信できなければ、失敗する。
 */
async function deliver(api: Pick<PageApi, "commit">, commit: Commit): Promise<Outcome> {
	try {
		const result = await api.commit(commit);
		return result.applied.length > 0 ? "applied" : "ineffective";
	} catch (error) {
		if (error instanceof PageApiError && error.kind === "rejected") return "rejected";
		throw error;
	}
}

/**
 * 記録が残していた変更を、コミットの列にする。
 * 送信中だったコミットは、そのまま(同じIDで)。まだ送っていなかった変更は、記録の内容から決まるIDを付けて、
 * コミットに収まる大きさに分ける。復元を途中からやり直しても、同じコミットとして送り直せる。
 */
async function commitsOf(entry: PendingEntry, includeUnsent: boolean): Promise<Commit[]> {
	const commits = entry.inflight === null ? [] : [entry.inflight];
	if (!includeUnsent) return commits;
	const source = JSON.stringify(entry);
	for (const [part, changes] of splitChanges(entry.changes).entries()) {
		commits.push({ id: await deriveCommitId(source, part), changes });
	}
	return commits;
}

/**
 * ページを開く。端末内に、前回送れなかった変更が残っていたら、復元する(ADR-0020、ADR-0021、ADR-0022)。
 *
 * 1. 閉じたタブが残した変更を引き取る。記録は、タブごとに1つ。古い順に並んでいる。
 * 2. 記録を古い順に、1つずつサーバーに入れる。行った順のとおりに入るので、古い記録の変更が、新しい記録の変更に勝つことがない。
 *    - 送信中だったコミットは、同じIDで送り直す。サーバーに入っていたら、何も起きない。
 *    - まだ送っていなかった変更も、コミットとして送る。ただし、最後の記録の分は送らない(4 で画面に載せる)。
 * 3. ページを読み込む(入れたコミットは、もう含まれている)。
 * 4. 最後の記録のまだ送っていなかった変更を、読み込んだページに載せる。画面に出てから、ふつうの編集と同じように保存される。
 *
 * サーバーに断られた変更(1行が長すぎる、など)は、捨てずに 4 で画面に載せる。画面に残り、送れないことが表示される。
 */
export async function restorePage(
	api: Pick<PageApi, "load" | "commit">,
	pending: { readonly adopt: () => Promise<readonly PendingEntry[]> },
): Promise<Restored> {
	const entries = await pending.adopt();

	/** サーバーに断られて、入れられなかった変更。 */
	const rejected: (readonly Change[])[] = [];
	let applied = false;
	for (const [index, entry] of entries.entries()) {
		for (const commit of await commitsOf(entry, index < entries.length - 1)) {
			const outcome = await deliver(api, commit);
			if (outcome === "rejected") rejected.push(commit.changes);
			applied = applied || outcome === "applied";
		}
	}

	const snapshot = await api.load();
	const unsent = entries.at(-1)?.changes ?? [];
	const document = withPending(snapshot.lines, [...rejected, unsent]);
	const restored = sameLines(document, snapshot.lines) ? null : document;
	return { snapshot, restored, noticed: applied || restored !== null };
}
