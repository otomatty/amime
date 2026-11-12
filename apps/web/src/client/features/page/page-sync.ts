import {
	acknowledge,
	type Change,
	type CommitResult,
	createSession,
	edit,
	failed,
	hasUnsaved,
	type Line,
	type PageSnapshot,
	resync,
	type Session,
	sameLines,
	send,
} from "@amime/sync";
import type { RemoteDocument } from "../editor/editor-model.ts";
import { PageApiError } from "./page-api-error.ts";

/** 最後の編集から保存を始めるまでの待ち時間。続けて打っているあいだは保存を始めない。 */
export const SAVE_DELAY_MS = 300;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * 保存の状態。
 * - new: まだないページを開いて、最初に表示した内容のまま(保存しない)
 * - saved: すべて保存済み
 * - unsaved: 未保存の変更がある(保存を待っている)
 * - saving: 保存中
 * - retrying: 保存に失敗し、再試行を待っている
 * - rejected: 送った内容をサーバーに断られた(内容を直すまで、送り直さない)
 */
export type SyncStatus = "new" | "saved" | "unsaved" | "saving" | "retrying" | "rejected";

export type PageSyncState = {
	readonly status: SyncStatus;
	/** 他の人の変更を取り込んだ結果、編集欄に渡す文書。取り込みがまだなければ null。 */
	readonly remote: RemoteDocument | null;
};

export type PageApi = {
	readonly load: () => Promise<PageSnapshot>;
	readonly commit: (changes: readonly Change[]) => Promise<CommitResult>;
};

type PageSyncOptions = {
	readonly snapshot: PageSnapshot;
	/**
	 * 編集欄に最初に表示する文書。保存されているページなら、読み込んだ行そのもの。
	 * まだないページでは、タイトルだけを入れた文書。この内容のままなら保存しない。
	 */
	readonly initial: readonly Line[];
	readonly api: PageApi;
	readonly onState: (state: PageSyncState) => void;
};

/**
 * 1つのページの保存を受け持つ。編集欄から文書を受け取り、サーバーへ送る。
 * 文書の状態と規則は @amime/sync のセッションにあり、ここは「いつ送るか」だけを決める。
 */
export function createPageSync({ snapshot, initial, api, onState }: PageSyncOptions) {
	let session: Session = edit(createSession(snapshot), initial);
	let remote: RemoteDocument | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = FIRST_RETRY_MS;
	let failure: "none" | "failed" | "rejected" = "none";
	let disposed = false;

	/** まだ1度も保存されていないページで、最初に表示した内容のままか。開いただけではページを作らない。 */
	const untouched = () => session.version === 0 && sameLines(session.local, initial);
	const status = (): SyncStatus => {
		if (session.inflight !== null) return "saving";
		if (untouched()) return "new";
		if (!hasUnsaved(session)) return "saved";
		if (failure === "rejected") return "rejected";
		return failure === "failed" ? "retrying" : "unsaved";
	};
	const publish = () => {
		if (!disposed) onState({ status: status(), remote });
	};

	const schedule = (delay: number) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void save();
		}, delay);
	};

	/** サーバーの結果を反映する。画面の文書が変わったら、編集欄に渡す文書として知らせる。 */
	const settle = (next: Session) => {
		if (next.local !== session.local) remote = { lines: next.local, base: session.local };
		session = next;
	};

	async function save(): Promise<void> {
		const sending = disposed || untouched() ? null : send(session);
		if (sending === null) return;
		session = sending.session;
		publish();
		try {
			const result = await api.commit(sending.changes);
			// 待っているあいだに編集されているかもしれないので、応答を受け取ったあとの session に対して反映する。
			const acknowledged = acknowledge(session, result);
			if (acknowledged === null) {
				// 他の人の変更が先に入っている。読み直しを待ってから、その時点の session に載せ直す。
				const latest = await api.load();
				settle(resync(session, latest));
			} else {
				settle(acknowledged);
			}
			failure = "none";
			retryDelay = FIRST_RETRY_MS;
		} catch (error) {
			session = failed(session);
			if (error instanceof PageApiError && error.kind === "rejected") {
				// 同じ内容を送り直しても通らない。内容が直される(次の編集)まで待つ。
				failure = "rejected";
				publish();
				return;
			}
			failure = "failed";
			publish();
			schedule(retryDelay);
			retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
			return;
		}
		publish();
		// 保存中に書き足した分があれば、続けて保存する。
		await save();
	}

	return {
		/** 編集欄の文書が変わったときに呼ぶ。 */
		edit(lines: readonly Line[]): void {
			session = edit(session, lines);
			if (failure === "rejected") failure = "none";
			publish();
			if (session.inflight === null && !untouched()) schedule(SAVE_DELAY_MS);
		},
		/** 待たずに、すぐ保存を試みる。 */
		flush(): void {
			void save();
		},
		/** 保存をやめる。 */
		dispose(): void {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		},
	};
}
