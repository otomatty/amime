import type { Change, ClientId, LineId } from "@amime/sync";
import { beforeEach, describe, expect, it } from "vitest";
import { createPendingStore, PENDING_MAX_AGE_MS } from "./pending-store.ts";

const client = (value: string) => value as ClientId;
const update = (text: string): Change => ({ type: "update", id: "a" as LineId, text });
const DAY = 24 * 60 * 60 * 1000;

function storeFor(
	tab: string,
	options: { page?: string; now?: number; storage?: Storage | null } = {},
) {
	return createPendingStore({
		storage: options.storage === undefined ? window.localStorage : options.storage,
		page: options.page ?? "メモ",
		client: client(tab),
		now: () => options.now ?? 1000,
	});
}

describe("createPendingStore", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("未送信の変更を残すと、別のタブ(次に開いたとき)から引き取れる", () => {
		expect(storeFor("old").save([update("A2")])).toBe(true);

		expect(storeFor("new").adopt()).toEqual([[update("A2")]]);
	});

	it("引き取った変更は、引き取った側の記録になる(引き取った直後に閉じても失われない)", () => {
		storeFor("old").save([update("A2")]);

		storeFor("new").adopt();

		expect(window.localStorage).toHaveLength(1);
		expect(storeFor("third").adopt()).toEqual([[update("A2")]]);
		expect(window.localStorage).toHaveLength(1);
	});

	it("未送信の変更がなくなったら、記録を消す", () => {
		const store = storeFor("old");
		store.save([update("A2")]);

		expect(store.save([])).toBe(true);

		expect(window.localStorage).toHaveLength(0);
		expect(storeFor("new").adopt()).toEqual([]);
	});

	it("複数のタブの記録を、古い順に引き取る", () => {
		storeFor("later", { now: 2000 }).save([update("あと")]);
		storeFor("earlier", { now: 1000 }).save([update("さき")]);

		expect(storeFor("new", { now: 3000 }).adopt()).toEqual([[update("さき")], [update("あと")]]);
	});

	it("自分の記録と、他のページの記録は引き取らない", () => {
		storeFor("me").save([update("自分")]);
		storeFor("other", { page: "別のページ" }).save([update("別")]);

		expect(storeFor("me").adopt()).toEqual([]);
		expect(storeFor("x", { page: "別のページ" }).adopt()).toEqual([[update("別")]]);
	});

	it("空白と大文字小文字の違いは、同じページとして扱う(サーバーと同じ)", () => {
		storeFor("old", { page: "My Page" }).save([update("A2")]);

		expect(storeFor("new", { page: "my_page" }).adopt()).toEqual([[update("A2")]]);
	});

	it("古すぎる記録と、読めない記録は、引き取らずに消す", () => {
		storeFor("stale", { now: 0 }).save([update("古い")]);
		window.localStorage.setItem(`amime:pending:${encodeURIComponent("メモ")}:broken`, "{");

		expect(storeFor("new", { now: PENDING_MAX_AGE_MS + 1 }).adopt()).toEqual([]);
		expect(window.localStorage).toHaveLength(0);
	});

	it("期限ちょうどの記録は引き取る", () => {
		storeFor("old", { now: 0 }).save([update("A2")]);

		expect(storeFor("new", { now: PENDING_MAX_AGE_MS }).adopt()).toEqual([[update("A2")]]);
		expect(PENDING_MAX_AGE_MS).toBe(30 * DAY);
	});

	it("保存先が使えなければ、残せなかったことを返す。引き取りは空になる", () => {
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
		expect(storeFor("new", { storage: null }).adopt()).toEqual([]);
	});

	it("引き取った変更を自分の記録に移せなかったときは、元の記録を消さない(変更は返す)", () => {
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

		expect(storeFor("new", { storage: readOnly }).adopt()).toEqual([[update("A2")]]);
		expect(storeFor("third").adopt()).toEqual([[update("A2")]]);
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
