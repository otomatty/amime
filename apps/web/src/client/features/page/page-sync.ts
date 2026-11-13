import {
	acknowledge,
	type Commit,
	type CommitId,
	type CommitResult,
	createSession,
	edit,
	failed,
	hasUnsaved,
	type Line,
	type PageSnapshot,
	type PendingEntry,
	pendingChanges,
	receive,
	resync,
	type Session,
	sameLines,
	send,
} from "@amime/sync";
import { PageApiError } from "./page-api-error.ts";
import type { PageSocket, PageSocketHandlers } from "./page-socket.ts";

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
/** 権限がないことを表す失敗(ログインしていない・メンバーでない、プロジェクトを見られない)。 */
const DENIED: ReadonlySet<PageApiError["kind"]> = new Set(["disabled", "missing"]);

export type SyncStatus =
	| "new"
	| "saved"
	| "unsaved"
	| "saving"
	| "retrying"
	| "rejected"
	/** ページが削除された(ADR-0026)。保存をやめている。 */
	| "deleted"
	/** 読み書きする権限がなくなった(ADR-0034)。保存をやめている。未送信の変更は、端末内に残っている。 */
	| "denied";

export type PageApi = {
	readonly load: () => Promise<PageSnapshot>;
	readonly commit: (commit: Commit) => Promise<CommitResult>;
	/** 他の端末のコミットを受け取り始める。返した接続を閉じると、受け取りをやめる。 */
	readonly subscribe: (handlers: PageSocketHandlers) => PageSocket;
};

type PageSyncOptions = {
	readonly snapshot: PageSnapshot;
	/**
	 * 編集欄に最初に表示する文書。保存されているページなら、読み込んだ行そのもの。
	 * 前回の未送信の変更を復元したときは、それを載せた文書(編集を待たずに保存する)。
	 */
	readonly initial: readonly Line[];
	/**
	 * initial が、まだないページに表示する仮の文書(タイトルだけ)か。
	 * 仮の文書は、内容がそのままなら保存しない(開いただけではページを作らない)。
	 */
	readonly placeholder: boolean;
	readonly api: PageApi;
	/**
	 * 保存には関わらない知らせの届け先。そのまま渡す。
	 * 他の人のカーソルと接続の状態(ADR-0023)、ページの名前(ADR-0024)。
	 */
	readonly listeners?: Omit<PageSocketHandlers, "onHello" | "onCommit" | "onDeleted">;
	/** 保存の状態を知らせる。 */
	readonly onStatus: (status: SyncStatus) => void;
	/**
	 * 他の人の変更を取り込んで、画面の文書が変わった。編集欄の文書を、渡した文書に置き換えること。
	 * 編集欄は、編集のたびに edit をその場で呼ぶ。そのため、ここで渡す文書は、いつも編集欄のいまの文書を
	 * もとに作ったものになっている(置き換えで、編集欄の入力が失われることはない)。
	 */
	readonly onRemote: (lines: readonly Line[]) => void;
	/**
	 * まだサーバーに入っていない変更を知らせる。なくなったら、空を知らせる。
	 * 端末内に残しておき、タブを閉じても次に開いたときに送れるようにするために使う(ADR-0020)。
	 */
	readonly onPending: (pending: PendingEntry) => void;
	/** コミットのIDを作る。 */
	readonly createCommitId: () => CommitId;
};

const NOTHING_PENDING: PendingEntry = { inflight: null, changes: [] };

/**
 * 1つのページの保存と、他の人の変更の受け取りを受け持つ。
 * 文書の状態と規則は @amime/sync のセッションにあり、ここは「いつ送るか、いつ読み直すか」だけを決める。
 */
export function createPageSync({
	snapshot,
	initial,
	placeholder,
	api,
	listeners,
	onStatus,
	onRemote,
	onPending,
	createCommitId,
}: PageSyncOptions) {
	let session: Session = edit(createSession(snapshot), initial);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = FIRST_RETRY_MS;
	let failure: "none" | "failed" | "rejected" = "none";
	/** ページが削除されたと分かった。保存も受け取りも、もう行わない。 */
	let deleted = false;
	/** 読み書きする権限がなくなったと分かったか。 */
	let denied = false;
	/** 送信中のコミットを作ったときの、画面の文書。断られたあとで、内容が直されたかどうかを見るのに使う。 */
	let sentLocal: readonly Line[] | null = null;
	/**
	 * サーバーにあると分かっている、いちばん新しいバージョン。
	 * 自分の持つバージョンがこれより古ければ、他の人のコミットを受け取りそこねているので、読み直して追いつく。
	 */
	let knownVersion = snapshot.version;
	let busy = false;
	let disposed = false;

	/** まだ1度も保存されていないページで、最初に表示した内容のままか。開いただけではページを作らない。 */
	const untouched = () =>
		placeholder &&
		session.version === 0 &&
		session.inflight === null &&
		sameLines(session.local, initial);
	const status = (): SyncStatus => {
		if (deleted) return "deleted";
		if (denied) return "denied";
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
	const behind = () => session.version < knownVersion;
	const publish = () => {
		if (disposed) return;
		onStatus(status());
		// 削除されたページの変更は、送る先がない。端末内にも残さない。
		const settled = deleted || untouched();
		onPending(settled ? NOTHING_PENDING : pendingChanges(session));
	};

	const schedule = (delay: number) => {
		// 止めたあとに、待っていた通信が失敗して戻ってくることがある。そのときは、もう再試行しない。
		if (disposed || deleted) return;
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void save();
		}, delay);
	};

	/** サーバーの結果を反映する。画面の文書が変わったら、編集欄の文書を置き換えさせる。 */
	const settle = (next: Session) => {
		const changed = next.local !== session.local;
		session = next;
		if (changed && !disposed) onRemote(next.local);
	};

	/** 送った内容をサーバーに断られた。断られるまでのあいだに内容が直されていたら、続けて保存する。 */
	const rejected = (): boolean => {
		const corrected = session.local !== sentLocal;
		session = failed(session);
		failure = corrected ? "none" : "rejected";
		publish();
		return corrected;
	};

	/**
	 * サーバーの応答を待っているあいだにページが削除されていたら、応答を使わずにやめる(ADR-0026)。
	 * 削除されたあとは、画面の文書を置き換えない。開いていた画面に残っている内容が、最後の写しかもしれない。
	 */
	const unlessDeleted = <T>(response: T): T => {
		if (deleted) throw new PageApiError("gone");
		return response;
	};

	/**
	 * 読み直して、サーバーに追いつく。送信中のコミットがないときにだけ呼ぶ。
	 * 読み直したページのほうが古ければ(待っているあいだに、配信でそれより先まで進んでいたら)、
	 * 何もせず false を返す。
	 */
	async function catchUp(): Promise<boolean> {
		const latest = unlessDeleted(await api.load());
		if (latest.version < session.version) return false;
		// 待っているあいだに送信が始まることはない(保存を進めるのは、1度に1つだけ)。
		if (latest.version > session.version) settle(resync(receiving(), latest));
		// 読み直したページより先のコミットがあると分かっていれば、まだ遅れている。もう1度読み直す。
		return !behind();
	}

	/** 送信への応答を反映する。他の人の変更が先に入っていたら、読み直して載せ直す。 */
	async function confirm(result: CommitResult): Promise<void> {
		const acknowledged = result.duplicate ? null : acknowledge(session, result);
		if (acknowledged !== null) {
			settle(acknowledged);
			return;
		}
		knownVersion = Math.max(knownVersion, result.version);
		if (result.applied.length === 0 && !result.duplicate) {
			// 何も効かなかったので、サーバーの文書は自分のコミットでは変わっていない。送信中の状態だけをやめる。
			// 遅れている分は、このあとの読み直し(catchUp)で追いつく。
			settle(acknowledge(session, { version: session.version, applied: [] }) ?? session);
			return;
		}
		// 自分のコミットは、サーバーに入っている(いま入ったか、送り直す前に入っていた)。
		// 読み直したページには、それが含まれている。
		const latest = unlessDeleted(await api.load());
		if (latest.version < result.version) throw new PageApiError("failed");
		settle(resync(session, latest));
	}

	/** ページが削除されたと分かった。保存と受け取りをやめる(ADR-0026)。 */
	function gone(): void {
		if (deleted) return;
		deleted = true;
		if (timer !== null) clearTimeout(timer);
		connection.close();
		publish();
	}

	/**
	 * 読み書きする権限がなくなったと分かった。保存と受け取りをやめる(ADR-0034)。
	 * 削除されたときと違って、未送信の変更は、端末内に残す(権限が戻って、開き直したときに送れる)。
	 */
	function lostAccess(): void {
		denied = true;
		if (timer !== null) clearTimeout(timer);
		connection.close();
		publish();
	}

	/** 失敗を記録する。続けてもう1回進めるべきなら true を返す。 */
	function fail(error: unknown, committing: boolean): boolean {
		if (error instanceof PageApiError && error.kind === "gone") {
			gone();
			return false;
		}
		if (error instanceof PageApiError && DENIED.has(error.kind)) {
			lostAccess();
			return false;
		}
		if (committing && error instanceof PageApiError && error.kind === "rejected") return rejected();
		// 送信中のコミットは、そのまま残す。サーバーに入ったかどうかは分からないので、
		// 次は、同じコミットを同じIDで送り直す。サーバーは、二重に適用しない(ADR-0021)。
		failure = "failed";
		publish();
		schedule(retryDelay);
		retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
		return false;
	}

	/**
	 * 次に送るコミットを決める。応答を受け取っていないコミットがあれば、それを送り直す。
	 * なければ、新しいコミットを作る。送るものがなければ null。
	 */
	async function nextCommit(): Promise<Commit | "retry" | null> {
		if (session.inflight !== null) return session.inflight;
		if (behind() && !(await catchUp())) return "retry";
		const sending = disposed || untouched() ? null : send(session, createCommitId());
		if (sending === null) return null;
		session = sending.session;
		sentLocal = session.local;
		return sending.commit;
	}

	/**
	 * 保存を1回分進める。続けてもう1回進めるべきなら true を返す。
	 * await のあとでは、待っているあいだに編集されたり配信が届いたりしているかもしれないので、
	 * 必ずその時点の session を使う。
	 */
	async function step(): Promise<boolean> {
		if (deleted || denied) return false;
		let committing = false;
		try {
			const commit = await nextCommit();
			if (commit === "retry") return true;
			if (commit === null) {
				failure = "none";
				publish();
				return false;
			}
			publish();

			committing = true;
			const result = unlessDeleted(await api.commit(commit));
			committing = false;
			await confirm(result);
			failure = "none";
			retryDelay = FIRST_RETRY_MS;
			publish();
			// 保存中に書き足した分があれば、続けて保存する。
			return true;
		} catch (error) {
			return fail(error, committing);
		}
	}

	async function save(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			// 送るものがなくなるか、失敗するまで続ける。待っているあいだに遅れが分かったら、もう1回進める。
			while ((await step()) || (behind() && failure !== "failed" && !deleted && !denied)) {
				// 繰り返すだけ。
			}
		} finally {
			busy = false;
		}
	}

	const connection = api.subscribe({
		...listeners,
		onDeleted: gone,
		onHello(version) {
			// つないだ時点でサーバーのほうが進んでいたら、切れているあいだのコミットを受け取りそこねている。
			knownVersion = Math.max(knownVersion, version);
			if (behind()) void save();
		},
		onCommit(event) {
			if (event.version <= session.version) return;
			const next = receive(receiving(), event);
			if (next === null) {
				// あいだのコミットが抜けている。読み直して追いつく。
				knownVersion = Math.max(knownVersion, event.version);
				void save();
				return;
			}
			settle(next);
			publish();
		},
	});

	publish();
	// 復元した変更を載せた文書から始めたときは、編集を待たずに保存する。
	if (hasUnsaved(session) && !untouched()) schedule(0);

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
		/** 自分のカーソルの位置を、他の端末に知らせる。 */
		sendCursor: connection.sendCursor,
		/** 保存をやめる。 */
		dispose(): void {
			disposed = true;
			connection.close();
			if (timer !== null) clearTimeout(timer);
		},
	};
}
