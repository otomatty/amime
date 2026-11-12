import { toTitleLc } from "@amime/shared";
import { type Change, type ClientId, type PendingRecord, parsePendingRecord } from "@amime/sync";

/** 残しておく期間。これより古い記録は、復元せずに消す。 */
export const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "amime:pending:";

/**
 * 未送信の変更を、端末(ブラウザ)の中に残しておく場所(ADR-0020)。
 * 記録は、ページと端末(タブ)の組ごとに1つ。
 */
export type PendingStore = {
	/**
	 * このタブの未送信の変更を残す。空なら、記録を消す。
	 * 残せなかったら(保存先が使えない、容量がいっぱい)false を返す。
	 */
	readonly save: (changes: readonly Change[]) => boolean;
	/**
	 * 同じページについて、他のタブ(閉じたタブ)が残した未送信の変更を引き取る。古い順に返す。
	 * 引き取った変更は、このタブの記録に移す。引き取った直後にこのタブが閉じても、変更は失われない。
	 */
	readonly adopt: () => readonly (readonly Change[])[];
};

type PendingStoreOptions = {
	/** 保存先。使えない環境では null。 */
	readonly storage: Storage | null;
	/** ページ名。 */
	readonly page: string;
	readonly client: ClientId;
	/** いまの時刻(ミリ秒)。テストで差し替える。 */
	readonly now?: () => number;
};

/** ブラウザの保存先を返す。使えない設定になっていれば null。 */
export function browserStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
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

export function createPendingStore({
	storage,
	page,
	client,
	now = Date.now,
}: PendingStoreOptions): PendingStore {
	// ページは、サーバーと同じ規則(空白と大文字小文字の違いは同じページ)で識別する。
	const pagePrefix = `${KEY_PREFIX}${encodeURIComponent(toTitleLc(page))}:`;
	const ownKey = `${pagePrefix}${client}`;
	/** 最後に残した変更。同じ内容を書き込み直さないために覚えておく。 */
	let lastSaved: string | null = null;

	const write = (target: Storage, changes: readonly Change[]): void => {
		const serialized = JSON.stringify(changes);
		if (serialized === lastSaved) return;
		if (changes.length === 0) target.removeItem(ownKey);
		else target.setItem(ownKey, JSON.stringify({ savedAt: now(), changes }));
		lastSaved = serialized;
	};

	/** 他のタブの記録を読む。読めない記録と古すぎる記録は、その場で消す。 */
	const readOthers = (target: Storage): { key: string; record: PendingRecord }[] => {
		const found: { key: string; record: PendingRecord }[] = [];
		for (const key of keysWith(target, pagePrefix)) {
			if (key === ownKey) continue;
			const record = parsePendingRecord(target.getItem(key));
			if (record.ok && now() - record.value.savedAt <= PENDING_MAX_AGE_MS) {
				found.push({ key, record: record.value });
			} else {
				target.removeItem(key);
			}
		}
		return found.sort((a, b) => a.record.savedAt - b.record.savedAt);
	};

	return {
		save(changes) {
			if (storage === null) return false;
			try {
				write(storage, changes);
				return true;
			} catch {
				return false;
			}
		},
		adopt() {
			if (storage === null) return [];
			try {
				const others = readOthers(storage);
				const records = others.map(({ record }) => record.changes);
				if (others.length === 0) return records;
				try {
					// 自分の記録に移してから、元の記録を消す。移せなければ、元の記録を残しておく。
					write(storage, records.flat());
					for (const { key } of others) storage.removeItem(key);
				} catch {
					// 引き取った変更は返す。記録は元のタブのものが残っている。
				}
				return records;
			} catch {
				return [];
			}
		},
	};
}
