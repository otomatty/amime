import {
	type Change,
	type Commit,
	type Line,
	type PageSnapshot,
	type PendingEntry,
	sameLines,
	withPending,
} from "@amime/sync";
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
 * 送り直したコミットの行方。
 * - before: 以前にサーバーに入っていた
 * - now: 今回の送り直しで、サーバーに入った
 * - rejected: サーバーに断られた。サーバーには入っていない
 */
type Outcome = { readonly kind: "before" | "now" | "rejected"; readonly effective: boolean };

async function resend(api: Pick<PageApi, "commit">, commit: Commit): Promise<Outcome> {
	try {
		const result = await api.commit(commit);
		return {
			kind: result.duplicate === true ? "before" : "now",
			effective: result.applied.length > 0,
		};
	} catch (error) {
		if (error instanceof PageApiError && error.kind === "rejected") {
			return { kind: "rejected", effective: false };
		}
		throw error;
	}
}

/**
 * 読み込んだページに載せる変更を、載せる順に並べる。
 *
 * 記録は古い順に並んでいる。まだ送っていなかった変更は、どれもまだ画面の上にしかないのに、
 * 送信中だったコミットは、先にサーバーに入る。そのまま載せると、古い記録の変更が、新しい記録のコミットに勝ってしまう。
 * そこで、今回の送り直しで入ったコミットは、それより古い記録にまだ送っていなかった変更があれば、そのあとにもう一度載せる。
 * 以前に入っていたコミットは載せない(そのあとに他の人がした変更を、上書きしてしまう)。
 * 本文の書き換えは、もう一度載せない。順序によらず文字単位で統合されるので(ADR-0022)、載せると足した文字が2重になる。
 * 元にした本文を持たない書き換え(以前の形の記録)は、統合されずに置き換わるので、もう一度載せる。
 *
 * サーバーに断られたコミットは、まだ送っていなかった変更として載せる(捨てると、書いたものが黙って消える)。
 */
function changesToApply(
	entries: readonly PendingEntry[],
	outcomes: readonly (Outcome | null)[],
): readonly (readonly Change[])[] {
	const records: (readonly Change[])[] = [];
	/** ここまでの記録に、まだサーバーに入っていない変更があるか。 */
	let unsent = false;
	entries.forEach(({ inflight, changes }, index) => {
		const kind = outcomes[index]?.kind;
		if (inflight !== null && kind === "rejected") {
			records.push(inflight.changes);
			unsent = true;
		} else if (inflight !== null && kind === "now" && unsent) {
			records.push(
				inflight.changes.filter((change) => change.type !== "update" || change.base === undefined),
			);
		}
		records.push(changes);
		unsent = unsent || changes.length > 0;
	});
	return records;
}

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

	const outcomes: (Outcome | null)[] = [];
	for (const { inflight } of entries) {
		outcomes.push(inflight === null ? null : await resend(api, inflight));
	}

	const snapshot = await api.load();
	const document = withPending(snapshot.lines, changesToApply(entries, outcomes));
	const restored = sameLines(document, snapshot.lines) ? null : document;
	const resent = outcomes.some((outcome) => outcome?.effective === true);
	return { snapshot, restored, noticed: resent || restored !== null };
}
