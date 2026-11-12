import type { Change, ClientId, LineId } from "@amime/sync";
import { beforeEach, describe, expect, it } from "vitest";
import { createPendingStore, PENDING_MAX_AGE_MS } from "./pending-store.ts";

const client = (value: string) => value as ClientId;
const update = (text: string): Change => ({ type: "update", id: "a" as LineId, text });
const DAY = 24 * 60 * 60 * 1000;

type Locks = Pick<LockManager, "request">;

/**
 * ロックの代わり。同じ名前のロックは、1度に1つの持ち主だけが持てる。
 * 取れるまで待つ動作は作っていない(持ち主がいるロックを頼むと、取れなかったことだけを伝える)。
 */
function createFakeLocks(): Locks {
	const held = new Set<string>();
	const request = async (
		name: string,
		optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
		maybeCallback?: LockGrantedCallback<unknown>,
	) => {
		const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
		if (!callback) throw new Error("callback is required");
		if (held.has(name)) return callback(null);
		held.add(name);
		try {
			return await callback({ name, mode: "exclusive" });
		} finally {
			held.delete(name);
		}
	};
	return { request } as Locks;
}

type StoreOptions = {
	page?: string;
	now?: number;
	storage?: Storage | null;
	/** 省くと、ロックが使えない環境(残っている記録をすべて引き取る)。 */
	locks?: Locks | null;
};

function storeFor(tab: string, options: StoreOptions = {}) {
	return createPendingStore({
		storage: options.storage === undefined ? window.localStorage : options.storage,
		locks: options.locks ?? null,
		page: options.page ?? "メモ",
		client: client(tab),
		now: () => options.now ?? 1000,
	});
}

describe("createPendingStore", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("未送信の変更を残すと、別のタブ(次に開いたとき)から引き取れる", async () => {
		expect(storeFor("old").save([update("A2")])).toBe(true);

		expect(await storeFor("new").adopt()).toEqual([[update("A2")]]);
	});

	it("引き取った変更は、引き取った側の記録になる(引き取った直後に閉じても失われない)", async () => {
		storeFor("old").save([update("A2")]);

		await storeFor("new").adopt();

		expect(window.localStorage).toHaveLength(1);
		expect(await storeFor("third").adopt()).toEqual([[update("A2")]]);
		expect(window.localStorage).toHaveLength(1);
	});

	it("未送信の変更がなくなったら、記録を消す", async () => {
		const store = storeFor("old");
		store.save([update("A2")]);

		expect(store.save([])).toBe(true);

		expect(window.localStorage).toHaveLength(0);
		expect(await storeFor("new").adopt()).toEqual([]);
	});

	it("複数のタブの記録を、古い順に引き取る", async () => {
		storeFor("later", { now: 2000 }).save([update("あと")]);
		storeFor("earlier", { now: 1000 }).save([update("さき")]);

		expect(await storeFor("new", { now: 3000 }).adopt()).toEqual([
			[update("さき")],
			[update("あと")],
		]);
	});

	it("自分の記録と、他のページの記録は引き取らない", async () => {
		storeFor("me").save([update("自分")]);
		storeFor("other", { page: "別のページ" }).save([update("別")]);

		expect(await storeFor("me").adopt()).toEqual([]);
		expect(await storeFor("x", { page: "別のページ" }).adopt()).toEqual([[update("別")]]);
	});

	it("空白と大文字小文字の違いは、同じページとして扱う(サーバーと同じ)", async () => {
		storeFor("old", { page: "My Page" }).save([update("A2")]);

		expect(await storeFor("new", { page: "my_page" }).adopt()).toEqual([[update("A2")]]);
	});

	it("古すぎる記録と、読めない記録は、引き取らずに消す", async () => {
		storeFor("stale", { now: 0 }).save([update("古い")]);
		window.localStorage.setItem(`amime:pending:${encodeURIComponent("メモ")}:broken`, "{");

		expect(await storeFor("new", { now: PENDING_MAX_AGE_MS + 1 }).adopt()).toEqual([]);
		expect(window.localStorage).toHaveLength(0);
	});

	it("期限ちょうどの記録は引き取る", async () => {
		storeFor("old", { now: 0 }).save([update("A2")]);

		expect(await storeFor("new", { now: PENDING_MAX_AGE_MS }).adopt()).toEqual([[update("A2")]]);
		expect(PENDING_MAX_AGE_MS).toBe(30 * DAY);
	});

	it("保存先が使えなければ、残せなかったことを返す。引き取りは空になる", async () => {
		const full = {
			...Object.fromEntries(
				["getItem", "removeItem", "key", "clear"].map((name) => [name, () => null]),
			),
			length: 0,
			setItem: () => {
				throw new DOMException("quota", "QuotaExceededError");
			},
		} as unknown as Storage;

		expect(storeFor("old", { storage: full }).save([update("A2")])).toBe(false);
		expect(storeFor("old", { storage: null }).save([update("A2")])).toBe(false);
		expect(await storeFor("new", { storage: null }).adopt()).toEqual([]);
	});

	it("引き取った変更を自分の記録に移せなかったときは、元の記録を消さない(変更は返す)", async () => {
		storeFor("old").save([update("A2")]);
		const readOnly = new Proxy(window.localStorage, {
			get(target, property) {
				if (property === "setItem") {
					return () => {
						throw new DOMException("quota", "QuotaExceededError");
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		expect(await storeFor("new", { storage: readOnly }).adopt()).toEqual([[update("A2")]]);
		expect(await storeFor("third").adopt()).toEqual([[update("A2")]]);
	});

	it("移せなかった元の記録は、未送信の変更がなくなったときに消す(次に開いたときに、古い変更を載せ直さない)", async () => {
		storeFor("old").save([update("A2")]);
		let failing = true;
		const flaky = new Proxy(window.localStorage, {
			get(target, property) {
				if (property === "setItem" && failing) {
					return () => {
						throw new DOMException("quota", "QuotaExceededError");
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const store = storeFor("new", { storage: flaky });
		await store.adopt();
		failing = false;

		// 引き取った変更を送り終えた。
		store.save([]);

		expect(window.localStorage).toHaveLength(0);
	});

	it("引き取りの途中で元のタブが記録を書き換えていたら、その記録は消さない", async () => {
		storeFor("old").save([update("A2")]);
		const key = `amime:pending:${encodeURIComponent("メモ")}:old`;
		// 読んだあと、消す前に、元のタブ(まだ開いている)が新しい変更を書き込む。
		const racing = new Proxy(window.localStorage, {
			get(target, property) {
				if (property === "setItem") {
					return (targetKey: string, value: string) => {
						target.setItem(targetKey, value);
						target.setItem(key, JSON.stringify({ savedAt: 2000, changes: [update("A3")] }));
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		expect(await storeFor("new", { storage: racing }).adopt()).toEqual([[update("A2")]]);

		expect(JSON.parse(String(window.localStorage.getItem(key))).changes).toEqual([update("A3")]);
	});

	it("自分の記録が他のタブに引き取られて消えていたら、次に残すときに書き直す", async () => {
		const store = storeFor("old");
		store.save([update("A2")]);
		await storeFor("new").adopt();

		// 内容は前と同じでも、記録がなくなっているので書き直す。
		store.save([update("A2")]);

		expect(await storeFor("third").adopt()).toEqual([[update("A2")], [update("A2")]]);
	});

	describe("開いているタブの記録", () => {
		it("開いているタブの記録は引き取らない。そのタブが閉じたら、引き取れる", async () => {
			const locks = createFakeLocks();
			const open = storeFor("open", { locks });
			const close = open.hold();
			open.save([update("A2")]);
			await Promise.resolve();

			expect(await storeFor("second", { locks }).adopt()).toEqual([]);
			expect(window.localStorage).toHaveLength(1);

			close();
			await Promise.resolve();
			expect(await storeFor("third", { locks }).adopt()).toEqual([[update("A2")]]);
		});

		it("閉じたタブの記録を、2つのタブが同時に引き取ろうとしても、片方だけが引き取る", async () => {
			const locks = createFakeLocks();
			storeFor("closed", { locks }).save([update("A2")]);

			// どちらのタブも開いている(自分の記録を、相手に引き取らせない)。
			const second = storeFor("second", { locks });
			const third = storeFor("third", { locks });
			second.hold();
			third.hold();

			const adopted = await Promise.all([second.adopt(), third.adopt()]);

			expect(adopted.flat()).toEqual([[update("A2")]]);
			expect(window.localStorage).toHaveLength(1);
		});

		it("引き取りは1度だけ行う。もう一度呼んでも、同じ結果を返す", async () => {
			storeFor("closed").save([update("A2")]);
			const store = storeFor("new");

			const first = await store.adopt();

			expect(await store.adopt()).toBe(first);
			expect(first).toEqual([[update("A2")]]);
		});

		it("ロックが使えない環境では、hold は何もしない", () => {
			expect(() => storeFor("open").hold()()).not.toThrow();
		});
	});

	it("同じ内容を続けて残すときは、書き込みを繰り返さない", () => {
		let writes = 0;
		const counting = new Proxy(window.localStorage, {
			get(target, property) {
				if (property === "setItem") {
					return (key: string, value: string) => {
						writes += 1;
						target.setItem(key, value);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const store = storeFor("old", { storage: counting });

		store.save([update("A2")]);
		store.save([update("A2")]);
		store.save([update("A3")]);

		expect(writes).toBe(2);
	});
});
