import { toTitleLc } from "@tsuzuri/shared";
import {
	type ClientId,
	type PageId,
	type PendingEntry,
	type PendingRecord,
	parsePendingRecord,
	type StoredPending,
} from "@tsuzuri/sync";

/** 残しておく期間。これより古い記録は、復元せずに消す。 */
export const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "tsuzuri:pending:";

/**
 * 未送信の変更を、端末(ブラウザ)の中に残しておく場所(ADR-0020)。
 * 記録は、ページと端末(タブ)の組ごとに1つ。
 */
export type PendingStore = {
	/**
	 * このタブの未送信の変更を残す。何もなければ、記録を消す。
	 * 残せなかったら(保存先が使えない、容量がいっぱい)false を返す。
	 */
	readonly save: (pending: PendingEntry) => boolean;
	/**
	 * 同じページについて、閉じたタブが残した未送信の変更を引き取る。古い順に返す。
	 * 引き取った変更は、このタブの記録に移す。引き取った直後にこのタブが閉じても、変更は失われない。
	 * まだ開いているタブの記録は引き取らない(そのタブが自分で送る)。
	 * 引き取りは1度だけ行う。もう一度呼ぶと、同じ結果を返す。
	 */
	readonly adopt: () => Promise<readonly PendingEntry[]>;
	/**
	 * ページの名前が変わったことを知らせる。記録に添える名前を直す(ADR-0042)。
	 * 残している記録があれば、その場で書き直す。
	 */
	readonly retitle: (title: string) => void;
	/**
	 * このタブが開いていることを、他のタブに示す。返した関数を呼ぶと、示すのをやめる。
	 * 示しているあいだ、このタブの記録は他のタブに引き取られない。タブが閉じたり落ちたりすると、自動で解かれる。
	 */
	readonly hold: () => () => void;
};

/** タブが開いているかどうかを確かめるためのロック(Web Locks API)。 */
type Locks = Pick<LockManager, "request">;

type PendingStoreOptions = {
	/** 保存先。使えない環境では null。 */
	readonly storage: Storage | null;
	/**
	 * ロック。使えない環境では null。そのときは、タブが開いているかどうかを確かめられないので、
	 * 残っている記録をすべて引き取る。
	 */
	readonly locks: Locks | null;
	/** プロジェクトの名前。どのページの記録かを、記録に添える(ADR-0042)。 */
	readonly project: string;
	/** ページID。 */
	readonly page: PageId;
	/** ページを開いたときの名前。名前が変わったら retitle で知らせる。 */
	readonly title: string;
	readonly client: ClientId;
	/** いまの時刻(ミリ秒)。テストで差し替える。 */
	readonly now?: () => number;
};

/** 他のタブが残した記録。raw は、読んだときの保存先の値。 */
type OtherRecord = {
	readonly key: string;
	readonly raw: string | null;
	readonly record: PendingRecord;
};

/** ブラウザの保存先を返す。使えない設定になっていれば null。 */
export function browserStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** ブラウザのロックを返す。対応していなければ null。 */
export function browserLocks(): Locks | null {
	return typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null;
}

/** 保存先にあるキーのうち、prefix で始まるものを返す。 */
function keysWith(storage: Storage, prefix: string): string[] {
	const keys: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (key?.startsWith(prefix)) keys.push(key);
	}
	return keys;
}

/**
 * この端末に残っている記録を、すべて読む(ADR-0042)。どのページの記録かが分かるものだけを返す
 * (この形を入れる前に残した記録には、ない)。読めない記録と古すぎる記録は返さない。読むだけで、消さない。
 */
export function listPendingRecords(
	storage: Storage | null,
	now: () => number = Date.now,
): StoredPending[] {
	if (storage === null) return [];
	try {
		return keysWith(storage, KEY_PREFIX).flatMap((key) => {
			const record = parsePendingRecord(storage.getItem(key));
			if (!record.ok || record.value.page === undefined) return [];
			if (now() - record.value.savedAt > PENDING_MAX_AGE_MS) return [];
			return [{ ...record.value.page, savedAt: record.value.savedAt }];
		});
	} catch {
		return [];
	}
}

export function createPendingStore({
	storage,
	locks,
	project,
	page,
	title: openedTitle,
	client,
	now = Date.now,
}: PendingStoreOptions): PendingStore {
	/** 記録に添える名前。ページの名前が変わったら、直す。 */
	let title = openedTitle;
	// ページは、サーバーと同じ規則(空白と大文字小文字の違いは同じページ)で識別する。
	const pagePrefix = `${KEY_PREFIX}${encodeURIComponent(toTitleLc(page))}:`;
	const ownKey = `${pagePrefix}${client}`;
	/** 最後に残した変更(と名前)。同じ内容を書き込み直さないために覚えておく。 */
	let lastSaved: string | null = null;
	/** 最後に残した変更と、その時刻。名前だけを直すときに、書き直すため。 */
	let lastEntries: readonly PendingEntry[] = [];
	let lastSavedAt = 0;
	/**
	 * 引き取ったが、自分の記録に移せなかったので消さずにおいた、他のタブの記録。
	 * release を呼ぶと、その記録のロックを解く(送り終えるまでは、他のタブに引き取らせない)。
	 */
	let leftovers: readonly { readonly other: OtherRecord; readonly release: () => void }[] = [];

	/** 読んだときから書き換えられていなければ、記録を消す。書き換えられていたら、元のタブがまだ使っている。 */
	const removeUnchanged = (target: Storage, { key, raw }: OtherRecord): void => {
		if (target.getItem(key) === raw) target.removeItem(key);
	};

	/** 自分の記録を書く。savedAt は、記録の新旧を比べるための時刻。 */
	const write = (target: Storage, entries: readonly PendingEntry[], savedAt: number): void => {
		if (entries.length === 0) {
			target.removeItem(ownKey);
			// 引き取った変更も送り終えた。移せなかった元の記録を残しておくと、次に開いたときに古い変更を載せ直してしまう。
			for (const { other, release } of leftovers) {
				removeUnchanged(target, other);
				release();
			}
			leftovers = [];
			lastSaved = null;
			lastEntries = [];
			return;
		}
		// 名前も含めて比べる。名前だけが変わったときも、書き直す。
		const serialized = JSON.stringify({ entries, title });
		// 内容が同じでも、他のタブに引き取られて記録が消えていたら、書き直す。
		if (serialized === lastSaved && target.getItem(ownKey) !== null) return;
		const record: PendingRecord = { savedAt, entries, page: { project, id: page, title } };
		target.setItem(ownKey, JSON.stringify(record));
		lastSaved = serialized;
		lastEntries = entries;
		lastSavedAt = savedAt;
	};

	/** 他のタブの記録を読む。読めない記録と古すぎる記録は、その場で消す。 */
	const readOthers = (target: Storage): OtherRecord[] => {
		const found: OtherRecord[] = [];
		for (const key of keysWith(target, pagePrefix)) {
			if (key === ownKey) continue;
			const raw = target.getItem(key);
			const record = parsePendingRecord(raw);
			// キーは、ページIDを小文字にして作る。大文字と小文字だけが違う、別のページの記録もここに入る。
			// そのページの変更なので、引き取らず、消さずに残す(ページの記録がない、前の形の記録は、これまでどおり)。
			if (record.ok && record.value.page !== undefined && record.value.page.id !== page) continue;
			if (record.ok && now() - record.value.savedAt <= PENDING_MAX_AGE_MS) {
				found.push({ key, raw, record: record.value });
			} else {
				target.removeItem(key);
			}
		}
		return found.sort((a, b) => a.record.savedAt - b.record.savedAt);
	};

	/** このタブが引き取った記録。 */
	const claimed: OtherRecord[] = [];

	/**
	 * 記録を1つ引き取る。
	 * - moved: 自分の記録に移して、元の記録を消した
	 * - kept: 引き取ったが、自分の記録に移せなかった。元の記録は残してある(送り終えたときに消す)
	 * - skipped: 読んだあとで記録が変わっていた(他のタブが先に引き取った、元のタブが書き換えた)
	 */
	const claim = (target: Storage, other: OtherRecord): "moved" | "kept" | "skipped" => {
		if (target.getItem(other.key) !== other.raw) return "skipped";
		claimed.push(other);
		try {
			// 記録は古い順に引き取る。移した記録の時刻は、最後に引き取った記録の時刻にする。
			// いまの時刻にすると、引き取りの途中で閉じたときに、まだ引き取っていない新しい記録と新旧が逆になる。
			const entries = claimed.flatMap(({ record }) => record.entries);
			write(target, entries, other.record.savedAt);
			removeUnchanged(target, other);
			return "moved";
		} catch {
			return "kept";
		}
	};

	/**
	 * 記録の持ち主のタブが閉じていれば、引き取る。
	 * 持ち主は、開いているあいだロックを持っている(hold)。ロックを取れたら、持ち主はもういない。
	 * ロックを持ったまま移すので、2つのタブが同じ記録を引き取ることもない。
	 * 自分の記録に移せなかったときは、送り終えるまでロックを持ち続ける(元の記録を、他のタブに引き取らせない)。
	 */
	const claimIfAbandoned = (target: Storage, other: OtherRecord): Promise<void> => {
		if (locks === null) {
			if (claim(target, other) === "kept") leftovers = [...leftovers, { other, release: () => {} }];
			return Promise.resolve();
		}
		return new Promise<void>((done) => {
			locks
				.request(other.key, { ifAvailable: true }, (lock) => {
					const outcome = lock === null ? "skipped" : claim(target, other);
					done();
					if (outcome !== "kept") return;
					// ロックは、返した約束が果たされるまで持ち続ける。
					return new Promise<void>((release) => {
						leftovers = [...leftovers, { other, release }];
					});
				})
				.catch(done);
		});
	};

	async function adoptOthers(): Promise<readonly PendingEntry[]> {
		if (storage === null) return [];
		try {
			for (const other of readOthers(storage)) await claimIfAbandoned(storage, other);
		} catch {
			// 保存先やロックが使えなくなった。そこまでに引き取れた分を返す。
		}
		return claimed.flatMap(({ record }) => record.entries);
	}
	let adopted: Promise<readonly PendingEntry[]> | null = null;

	return {
		save(pending) {
			if (storage === null) return false;
			try {
				const empty = pending.inflight === null && pending.changes.length === 0;
				// 残した端末の識別子を添える。復元のときに、内容が同じ別の変更と区別できる(ADR-0022)。
				write(storage, empty ? [] : [{ ...pending, origin: client }], now());
				return true;
			} catch {
				return false;
			}
		},
		adopt() {
			adopted ??= adoptOthers();
			return adopted;
		},
		retitle(next) {
			if (next === title) return;
			title = next;
			if (storage === null || lastSaved === null) return;
			try {
				// 時刻は変えない(記録の新旧を比べるための時刻なので、変更を残した時刻のままにする)。
				write(storage, lastEntries, lastSavedAt);
			} catch {
				// 書き直せなくても、変更は前の名前のまま残っている。次に残すときに、新しい名前になる。
			}
		},
		hold() {
			if (locks === null) return () => {};
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			// ロックは、渡した関数の約束が果たされるまで持ち続ける。タブが閉じれば、自動で解かれる。
			locks.request(ownKey, () => held).catch(() => {});
			return release;
		},
	};
}
