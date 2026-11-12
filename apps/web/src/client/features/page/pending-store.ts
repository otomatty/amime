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
	/** 引き取ったが、自分の記録に移せなかったので消さずにおいた、他のタブの記録。 */
	let leftovers: readonly OtherRecord[] = [];

	/** 読んだときから書き換えられていなければ、記録を消す。書き換えられていたら、元のタブがまだ使っている。 */
	const removeUnchanged = (target: Storage, { key, raw }: OtherRecord): void => {
		if (target.getItem(key) === raw) target.removeItem(key);
	};

	const write = (target: Storage, changes: readonly Change[]): void => {
		if (changes.length === 0) {
			target.removeItem(ownKey);
			// 引き取った変更も送り終えた。移せなかった元の記録を残しておくと、次に開いたときに古い変更を載せ直してしまう。
			for (const other of leftovers) removeUnchanged(target, other);
			leftovers = [];
			lastSaved = null;
			return;
		}
		const serialized = JSON.stringify(changes);
		// 内容が同じでも、他のタブに引き取られて記録が消えていたら、書き直す。
		if (serialized === lastSaved && target.getItem(ownKey) !== null) return;
		target.setItem(ownKey, JSON.stringify({ savedAt: now(), changes }));
		lastSaved = serialized;
	};

	/** 他のタブの記録を読む。読めない記録と古すぎる記録は、その場で消す。 */
	const readOthers = (target: Storage): OtherRecord[] => {
		const found: OtherRecord[] = [];
		for (const key of keysWith(target, pagePrefix)) {
			if (key === ownKey) continue;
			const raw = target.getItem(key);
			const record = parsePendingRecord(raw);
			if (record.ok && now() - record.value.savedAt <= PENDING_MAX_AGE_MS) {
				found.push({ key, raw, record: record.value });
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
					// 自分の記録に移してから、元の記録を消す。
					write(storage, records.flat());
					for (const other of others) removeUnchanged(storage, other);
				} catch {
					// 移せなかった。変更は返すが、元の記録は残しておき、送り終えたときに消す。
					leftovers = others;
				}
				return records;
			} catch {
				return [];
			}
		},
	};
}
