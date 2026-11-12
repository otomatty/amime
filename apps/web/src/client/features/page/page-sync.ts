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
	recover,
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
	/** 応答が届かなかった送信がある。サーバーに入ったかどうかが分からないので、次に送る前に読み直す。 */
	let uncertain = false;
	let busy = false;
	let disposed = false;

	/** まだ1度も保存されていないページで、最初に表示した内容のままか。開いただけではページを作らない。 */
	const untouched = () =>
		session.version === 0 && session.inflight === null && sameLines(session.local, initial);
	const status = (): SyncStatus => {
		if (untouched()) return "new";
		if (failure === "failed") return "retrying";
		if (session.inflight !== null) return "saving";
		if (!hasUnsaved(session)) return "saved";
		return failure === "rejected" ? "rejected" : "unsaved";
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

	/** 送った内容をサーバーに断られた。断られるまでのあいだに内容が直されていたら、続けて保存する。 */
	const rejected = (sentLocal: readonly Line[]): boolean => {
		const corrected = session.local !== sentLocal;
		session = failed(session);
		failure = corrected ? "none" : "rejected";
		publish();
		return corrected;
	};

	/**
	 * 保存を1回分進める。続けてもう1回進めるべきなら true を返す。
	 * await のあとでは、待っているあいだに編集されているかもしれないので、必ずその時点の session を使う。
	 */
	async function step(): Promise<boolean> {
		let sentLocal: readonly Line[] | null = null;
		try {
			if (uncertain) {
				const latest = await api.load();
				settle(recover(session, latest));
				uncertain = false;
			}
			const sending = disposed || untouched() ? null : send(session);
			if (sending === null) {
				failure = "none";
				publish();
				return false;
			}
			session = sending.session;
			publish();

			sentLocal = session.local;
			const result = await api.commit(sending.changes);
			sentLocal = null;
			const acknowledged = acknowledge(session, result);
			if (acknowledged === null) {
				// 他の人の変更が先に入っている。読み直して、その時点の session に載せ直す。
				const latest = await api.load();
				settle(resync(session, latest));
			} else {
				settle(acknowledged);
			}
			failure = "none";
			retryDelay = FIRST_RETRY_MS;
			publish();
			// 保存中に書き足した分があれば、続けて保存する。
			return true;
		} catch (error) {
			if (sentLocal !== null && error instanceof PageApiError && error.kind === "rejected") {
				return rejected(sentLocal);
			}
			// 送信中に失敗したら、サーバーに入ったかどうかが分からない。次に送る前に読み直す。
			uncertain = uncertain || session.inflight !== null;
			failure = "failed";
			publish();
			schedule(retryDelay);
			retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
			return false;
		}
	}

	async function save(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			while (await step()) {
				// 送るものがなくなるか、失敗するまで続ける。
			}
		} finally {
			busy = false;
		}
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
