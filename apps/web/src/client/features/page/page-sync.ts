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
	receive,
	recover,
	resync,
	type Session,
	sameLines,
	send,
} from "@amime/sync";
import type { RemoteDocument } from "../editor/editor-model.ts";
import { PageApiError } from "./page-api-error.ts";
import type { PageSocketHandlers } from "./page-socket.ts";

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
	/** 他の端末のコミットを受け取り始める。返した関数を呼ぶと、受け取りをやめる。 */
	readonly subscribe: (handlers: PageSocketHandlers) => () => void;
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
 * 1つのページの保存と、他の人の変更の受け取りを受け持つ。
 * 文書の状態と規則は @amime/sync のセッションにあり、ここは「いつ送るか、いつ読み直すか」だけを決める。
 */
export function createPageSync({ snapshot, initial, api, onState }: PageSyncOptions) {
	let session: Session = edit(createSession(snapshot), initial);
	let remote: RemoteDocument | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = FIRST_RETRY_MS;
	let failure: "none" | "failed" | "rejected" = "none";
	/** 応答が届かなかった送信がある。サーバーに入ったかどうかが分からないので、次に送る前に読み直す。 */
	let uncertain = false;
	/** 他の人のコミットを受け取りそこねている。読み直して追いつく。 */
	let behind = false;
	let busy = false;
	let disposed = false;

	/** まだ1度も保存されていないページで、最初に表示した内容のままか。開いただけではページを作らない。 */
	const untouched = () =>
		session.version === 0 && session.inflight === null && sameLines(session.local, initial);
	const status = (): SyncStatus => {
		if (untouched()) return "new";
		if (!hasUnsaved(session)) return "saved";
		if (failure === "failed") return "retrying";
		if (session.inflight !== null) return "saving";
		return failure === "rejected" ? "rejected" : "unsaved";
	};
	/**
	 * 他の人の変更を取り込むときの、もとにする状態。
	 * まだないページで仮のタイトルを表示しているだけなら、それは自分の編集ではないので、載せ直さない。
	 */
	const receiving = (): Session => (untouched() ? edit(session, session.confirmed) : session);
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
	 * 読み直して、サーバーに追いつく。読み直したページのほうが古ければ(待っているあいだに、
	 * 配信でそれより先まで進んでいたら)、何もせず false を返す。
	 */
	async function catchUp(): Promise<boolean> {
		const latest = await api.load();
		if (latest.version < session.version) return false;
		if (uncertain || latest.version > session.version) settle(recover(receiving(), latest));
		uncertain = false;
		behind = false;
		return true;
	}

	/** 送信への応答を反映する。他の人の変更が先に入っていたら、読み直して載せ直す。 */
	async function confirm(result: CommitResult): Promise<void> {
		const acknowledged = acknowledge(session, result);
		if (acknowledged !== null) {
			settle(acknowledged);
			return;
		}
		const latest = await api.load();
		settle(resync(session, latest));
	}

	/** 失敗を記録する。続けてもう1回進めるべきなら true を返す。 */
	function fail(error: unknown, sentLocal: readonly Line[] | null): boolean {
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

	/**
	 * 保存を1回分進める。続けてもう1回進めるべきなら true を返す。
	 * await のあとでは、待っているあいだに編集されたり配信が届いたりしているかもしれないので、
	 * 必ずその時点の session を使う。
	 */
	async function step(): Promise<boolean> {
		let sentLocal: readonly Line[] | null = null;
		try {
			if ((uncertain || behind) && !(await catchUp())) return true;
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
			await confirm(result);
			failure = "none";
			retryDelay = FIRST_RETRY_MS;
			publish();
			// 保存中に書き足した分があれば、続けて保存する。
			return true;
		} catch (error) {
			return fail(error, sentLocal);
		}
	}

	async function save(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			// 送るものがなくなるか、失敗するまで続ける。待っているあいだに遅れが分かったら、もう1回進める。
			while ((await step()) || (behind && failure !== "failed")) {
				// 繰り返すだけ。
			}
		} finally {
			busy = false;
		}
	}

	const unsubscribe = api.subscribe({
		onHello(version) {
			// つないだ時点でサーバーのほうが進んでいたら、切れているあいだのコミットを受け取りそこねている。
			if (version <= session.version) return;
			behind = true;
			void save();
		},
		onCommit(event) {
			if (event.version <= session.version) return;
			const next = receive(receiving(), event);
			if (next === null) {
				// あいだのコミットが抜けている。読み直して追いつく。
				behind = true;
				void save();
				return;
			}
			settle(next);
			publish();
		},
	});

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
			unsubscribe();
			if (timer !== null) clearTimeout(timer);
		},
	};
}
