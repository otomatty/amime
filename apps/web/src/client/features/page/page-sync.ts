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
	send,
} from "@amime/sync";
import type { RemoteDocument } from "../editor/editor-model.ts";

/** 最後の編集から保存を始めるまでの待ち時間。続けて打っているあいだは保存を始めない。 */
export const SAVE_DELAY_MS = 300;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * 保存の状態。
 * - saved: すべて保存済み
 * - unsaved: 未保存の変更がある(保存を待っている)
 * - saving: 保存中
 * - retrying: 保存に失敗し、再試行を待っている
 */
export type SyncStatus = "saved" | "unsaved" | "saving" | "retrying";

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
	readonly api: PageApi;
	readonly onState: (state: PageSyncState) => void;
};

/**
 * 1つのページの保存を受け持つ。編集欄から文書を受け取り、サーバーへ送る。
 * 文書の状態と規則は @amime/sync のセッションにあり、ここは「いつ送るか」だけを決める。
 */
export function createPageSync({ snapshot, api, onState }: PageSyncOptions) {
	let session: Session = createSession(snapshot);
	let remote: RemoteDocument | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = FIRST_RETRY_MS;
	let lastFailed = false;
	let disposed = false;

	const status = (): SyncStatus => {
		if (session.inflight !== null) return "saving";
		if (!hasUnsaved(session)) return "saved";
		return lastFailed ? "retrying" : "unsaved";
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
		const sending = disposed ? null : send(session);
		if (sending === null) return;
		session = sending.session;
		publish();
		try {
			const result = await api.commit(sending.changes);
			// 待っているあいだに編集されているかもしれないので、いまの session に対して反映する。
			settle(acknowledge(session, result) ?? resync(session, await api.load()));
			lastFailed = false;
			retryDelay = FIRST_RETRY_MS;
		} catch {
			session = failed(session);
			lastFailed = true;
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
			publish();
			if (session.inflight === null) schedule(SAVE_DELAY_MS);
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
