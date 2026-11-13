import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { app } from "./app.ts";

const get = (path: string) => exports.default.fetch(`https://amime.test${path}`);
const post = (path: string, body: unknown) =>
	exports.default.fetch(`https://amime.test${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

let commitSerial = 0;
/** 呼ぶたびに違う、コミットのID。 */
const commitId = () => {
	commitSerial += 1;
	return `app-test-${commitSerial}`;
};

const insertTitle = { type: "insert", line: { id: "c1-0", text: "題" }, after: null, before: null };

describe("GET /api/health", () => {
	it("稼働中であることを返す", async () => {
		const response = await get("/api/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});

describe("未定義のAPIパス", () => {
	it("JSONの404を返す", async () => {
		const response = await get("/api/unknown");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not-found" });
	});
});

describe("ページのAPI", () => {
	it("まだ書かれていないページは、バージョン0で行がない", async () => {
		const response = await get("/api/pages/api-new");

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ version: 0, lines: [] });
	});

	it("コミットを送ると変更が保存され、効いた変更とバージョンが返る", async () => {
		const response = await post("/api/pages/api-commit/commits", {
			id: commitId(),
			changes: [insertTitle],
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ version: 1, applied: [insertTitle] });
		expect(await (await get("/api/pages/api-commit")).json()).toEqual({
			version: 1,
			lines: [{ id: "c1-0", text: "題" }],
		});
	});

	it("ページのIDに使えない文字があれば 400 で断る", async () => {
		const read = await get(`/api/pages/${encodeURIComponent("メモ")}`);
		const write = await post(`/api/pages/${encodeURIComponent("a b")}/commits`, {
			id: commitId(),
			changes: [insertTitle],
		});

		expect(read.status).toBe(400);
		expect(await read.json()).toEqual({ error: "invalid-page" });
		expect(write.status).toBe(400);
	});

	it.each([
		["JSONでない本文", "{"],
		["changes のない本文", {}],
		["形の違う変更", { id: commitId(), changes: [{ type: "delete" }] }],
	])("%sは 400 で断り、何も保存しない", async (_name, body) => {
		const response = await post("/api/pages/api-invalid/commits", body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid-commit" });
		expect(await (await get("/api/pages/api-invalid")).json()).toEqual({ version: 0, lines: [] });
	});

	it("コミットのIDがない本文は 400 で断る", async () => {
		const response = await post("/api/pages/api-no-id/commits", { changes: [] });

		expect(response.status).toBe(400);
	});

	it("同じIDのコミットを送り直しても、二重に適用しない。重複だと分かる応答を返す", async () => {
		const body = { id: "api-retry", changes: [insertTitle] };
		await post("/api/pages/api-retry/commits", body);

		const response = await post("/api/pages/api-retry/commits", body);

		expect(await response.json()).toEqual({ version: 1, applied: [], duplicate: true });
	});

	it("接続したとき、台帳に確かめてあるページの名前も届く(切れているあいだに名前が変わっていても、追いつく)", async () => {
		const info = (await (await get("/api/pages/by-title/ws-name")).json()) as { id: string };
		const stub = exports.PageDO.getByName(`default/${info.id}`);
		await post(`/api/pages/${info.id}/commits`, {
			id: commitId(),
			changes: [
				{ type: "insert", line: { id: "t", text: "ws 新しい名前" }, after: null, before: null },
			],
		});
		await runDurableObjectAlarm(stub);

		const response = await exports.default.fetch(
			`https://amime.test/api/pages/${info.id}/socket?client=late`,
			{ headers: { Upgrade: "websocket" } },
		);
		const messages: unknown[] = [];
		response.webSocket?.accept();
		response.webSocket?.addEventListener("message", ({ data }) => {
			messages.push(JSON.parse(String(data)));
		});

		await vi.waitFor(() =>
			expect(messages).toEqual([
				{ type: "hello", version: 1 },
				{ type: "page", title: "ws 新しい名前", problem: null },
			]),
		);
	});

	describe("名前からページを引く(ADR-0024)", () => {
		const open = async (title: string) => {
			const response = await get(`/api/pages/by-title/${encodeURIComponent(title)}`);
			return { response, info: (await response.json()) as { id: string; title: string } };
		};

		it("名前から、ページのIDと名前を返す。まだないページには、IDを決める", async () => {
			const { response, info } = await open("Api 名前");

			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(info).toEqual({
				id: expect.any(String),
				title: "Api 名前",
				problem: null,
				pinned: false,
			});
			// 開いただけでは、ページは作られない。
			expect(await (await get(`/api/pages/${info.id}`)).json()).toEqual({ version: 0, lines: [] });
		});

		it("大文字小文字と、空白かアンダースコアかの違いは、同じページとして扱う", async () => {
			const first = await open("API Title メモ");
			const second = await open("api_title メモ");

			expect(second.info.id).toBe(first.info.id);
		});

		it("引いたIDで、ページを読み書きできる", async () => {
			const { info } = await open("api-by-id");

			await post(`/api/pages/${info.id}/commits`, { id: commitId(), changes: [insertTitle] });

			expect(await (await get(`/api/pages/${info.id}`)).json()).toMatchObject({ version: 1 });
		});

		it("長すぎる名前は 400 で断る", async () => {
			const { response, info } = await open("a".repeat(201));

			expect(response.status).toBe(400);
			expect(info).toEqual({ error: "invalid-page-name" });
		});

		it("ページを書き換えたあと、少しして、ページの名前が1行目に合う。接続している端末に知らせる", async () => {
			const { info } = await open("api-rename");
			const stub = exports.PageDO.getByName(`default/${info.id}`);
			const response = await exports.default.fetch(
				`https://amime.test/api/pages/${info.id}/socket?client=reader`,
				{ headers: { Upgrade: "websocket" } },
			);
			const messages: unknown[] = [];
			response.webSocket?.accept();
			response.webSocket?.addEventListener("message", ({ data }) => {
				messages.push(JSON.parse(String(data)));
			});

			await post(`/api/pages/${info.id}/commits`, {
				id: commitId(),
				changes: [
					{ type: "insert", line: { id: "t", text: "新しい名前" }, after: null, before: null },
				],
				client: "writer",
			});
			// 台帳への知らせは、書き換えが落ち着いてから送る。テストでは、待たずに実行する。
			expect(await runDurableObjectAlarm(stub)).toBe(true);

			expect((await open("新しい名前")).info.id).toBe(info.id);
			await vi.waitFor(() =>
				expect(messages.at(-1)).toEqual({ type: "page", title: "新しい名前", problem: null }),
			);
		});
	});

	it("大きすぎる本文は 413 で断る", async () => {
		const response = await post("/api/pages/api-large/commits", "x".repeat(2 * 1024 * 1024 + 1));

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "commit-too-large" });
	});

	describe("ページの一覧(ADR-0025)", () => {
		/** ページを作り、台帳への知らせが済むのを待つ。 */
		async function create(title: string, ...body: string[]) {
			const info = (await (
				await get(`/api/pages/by-title/${encodeURIComponent(title)}`)
			).json()) as { id: string };
			const texts = [title, ...body];
			await post(`/api/pages/${info.id}/commits`, {
				id: commitId(),
				changes: texts.map((text, index) => ({
					type: "insert",
					line: { id: `l${index}`, text },
					after: index === 0 ? null : `l${index - 1}`,
					before: null,
				})),
			});
			await runDurableObjectAlarm(exports.PageDO.getByName(`default/${info.id}`));
			return info.id;
		}
		type Listed = { pages: { id: string; title: string; linked: number }[]; total: number };
		const list = async (query = "") => {
			const response = await get(`/api/pages${query}`);
			return { response, body: (await response.json()) as Listed };
		};

		it("保存されたページを、冒頭の本文・画像・リンクされている数と一緒に返す", async () => {
			const egg = await create("一覧 卵");
			const shopping = await create(
				"一覧 買い物",
				"[一覧 卵] を買う",
				"[https://example.com/a.png]",
			);

			const { response, body } = await list("?sort=title");

			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(body.pages.find((page) => page.id === shopping)).toEqual({
				id: shopping,
				title: "一覧 買い物",
				descriptions: ["一覧 卵 を買う"],
				image: "https://example.com/a.png",
				updated: expect.any(Number),
				created: expect.any(Number),
				linked: 0,
				pinned: false,
			});
			expect(body.pages.find((page) => page.id === egg)?.linked).toBe(1);
			expect(body.total).toBeGreaterThanOrEqual(2);
		});

		it("並び順を省くと、更新が新しい順", async () => {
			const first = await create("一覧 先に書いた");
			const second = await create("一覧 あとで書いた");

			const ids = (await list()).body.pages.map((page) => page.id);

			expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
		});

		it("件数と始まりを指定できる", async () => {
			await create("一覧 ページ1");
			await create("一覧 ページ2");

			const { body } = await list("?sort=title&limit=1&offset=1");

			expect(body.pages).toHaveLength(1);
		});

		it.each([
			["知らない並び順", "?sort=popular"],
			["数でない件数", "?limit=many"],
			["負の始まり", "?offset=-1"],
			["小数の件数", "?limit=1.5"],
		])("%sは 400 で断る", async (_name, query) => {
			const { response, body } = await list(query);

			expect(response.status).toBe(400);
			expect(body).toEqual({ error: "invalid-query" });
		});
	});

	describe("固定と削除(ADR-0026)", () => {
		const send = (method: string, path: string, body?: unknown) =>
			exports.default.fetch(`https://amime.test${path}`, {
				method,
				...(body !== undefined && {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			});
		/** 保存されたページを作り、台帳への知らせが済むのを待つ。 */
		async function create(title: string) {
			const info = (await (
				await get(`/api/pages/by-title/${encodeURIComponent(title)}`)
			).json()) as { id: string };
			await post(`/api/pages/${info.id}/commits`, {
				id: commitId(),
				changes: [{ type: "insert", line: { id: "t", text: title }, after: null, before: null }],
			});
			await runDurableObjectAlarm(exports.PageDO.getByName(`default/${info.id}`));
			return info.id;
		}
		const listed = async () => {
			const body = (await (await get("/api/pages?sort=title")).json()) as {
				pages: { id: string; pinned: boolean }[];
			};
			return body.pages;
		};

		it("ページを固定すると、一覧の先頭に並ぶ。固定を外すと戻る", async () => {
			const id = await create("固定 するページ");

			const pinned = await send("PUT", `/api/pages/${id}/pin`, { pinned: true });

			expect(pinned.status).toBe(200);
			expect(await pinned.json()).toMatchObject({ id, pinned: true });
			expect((await listed())[0]).toMatchObject({ id, pinned: true });

			const released = await send("PUT", `/api/pages/${id}/pin`, { pinned: false });
			expect(await released.json()).toMatchObject({ id, pinned: false });
		});

		it.each([
			["本文がない", undefined],
			["pinned がない", {}],
			["pinned が真偽値でない", { pinned: "yes" }],
		])("固定の指定で、%sときは 400 で断る", async (_name, body) => {
			const response = await send("PUT", "/api/pages/pin-invalid/pin", body);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid-pin" });
		});

		it("台帳にないページは、固定できない(404)", async () => {
			const response = await send("PUT", "/api/pages/pin-unknown/pin", { pinned: true });

			expect(response.status).toBe(404);
		});

		it("ページを削除すると、一覧から消え、読み込みも書き込みも 410 になる", async () => {
			const id = await create("削除 するページ");

			const response = await send("DELETE", `/api/pages/${id}`);

			expect(response.status).toBe(204);
			expect((await listed()).map((page) => page.id)).not.toContain(id);
			const read = await get(`/api/pages/${id}`);
			expect(read.status).toBe(410);
			expect(await read.json()).toEqual({ error: "page-deleted" });
			const write = await post(`/api/pages/${id}/commits`, {
				id: commitId(),
				changes: [insertTitle],
			});
			expect(write.status).toBe(410);
			// 削除は、何度呼んでも同じ結果になる。
			expect((await send("DELETE", `/api/pages/${id}`)).status).toBe(204);
		});

		it("削除したあとで同じ名前を開くと、別の新しいページになる。書き込める", async () => {
			const id = await create("削除して 作り直す");
			await send("DELETE", `/api/pages/${id}`);

			const reopened = (await (
				await get(`/api/pages/by-title/${encodeURIComponent("削除して 作り直す")}`)
			).json()) as { id: string };

			expect(reopened.id).not.toBe(id);
			expect(await (await get(`/api/pages/${reopened.id}`)).json()).toEqual({
				version: 0,
				lines: [],
			});
		});

		it("削除が途中で止まり、台帳にだけ残ったページは、読もうとしたときに台帳からも消す", async () => {
			const title = "削除が 途中で止まった";
			const id = await create(title);
			// 本文は消えたが、台帳から消す前に失敗した、という状態を作る。
			await exports.PageDO.getByName(`default/${id}`).destroy();
			expect((await listed()).map((page) => page.id)).toContain(id);

			const read = await get(`/api/pages/${id}`);

			expect(read.status).toBe(410);
			expect((await listed()).map((page) => page.id)).not.toContain(id);
			// 同じ名前で、新しいページを作り直せる。
			const reopened = (await (
				await get(`/api/pages/by-title/${encodeURIComponent(title)}`)
			).json()) as { id: string };
			expect(reopened.id).not.toBe(id);
		});

		it("削除すると、開いている端末に知らせる。あとから接続した端末にも、削除されたことだけを伝えて閉じる", async () => {
			const id = await create("削除を 知らせる");
			const connect = async (client: string) => {
				const response = await exports.default.fetch(
					`https://amime.test/api/pages/${id}/socket?client=${client}`,
					{ headers: { Upgrade: "websocket" } },
				);
				const messages: unknown[] = [];
				const closes: number[] = [];
				response.webSocket?.accept();
				response.webSocket?.addEventListener("message", ({ data }) => {
					messages.push(JSON.parse(String(data)));
				});
				response.webSocket?.addEventListener("close", ({ code }) => closes.push(code));
				return { messages, closes };
			};
			const open = await connect("open");

			await send("DELETE", `/api/pages/${id}`);

			await vi.waitFor(() => expect(open.messages.at(-1)).toEqual({ type: "deleted" }));
			// 知らせたあとは、サーバーの側から接続を閉じる。
			await vi.waitFor(() => expect(open.closes).toEqual([1000]));
			const late = await connect("late");
			await vi.waitFor(() => expect(late.closes).toEqual([1000]));
			expect(late.messages).toEqual([{ type: "deleted" }]);
		});

		it("削除したページでは、台帳への知らせを行わない", async () => {
			const id = await create("削除後に 知らせない");
			const stub = exports.PageDO.getByName(`default/${id}`);
			await post(`/api/pages/${id}/commits`, {
				id: commitId(),
				changes: [{ type: "update", id: "t", text: "書き換えた" }],
			});

			await send("DELETE", `/api/pages/${id}`);

			expect(await runDurableObjectAlarm(stub)).toBe(false);
		});
	});

	describe("ページのAPIが無効な環境(認証が入るまでの公開環境)", () => {
		it("一覧を 403 で断る", async () => {
			const response = await app.request(
				"/api/pages",
				{},
				{ ...env, PAGE_API: "disabled" as const },
			);

			expect(response.status).toBe(403);
		});

		const disabled = { ...env, PAGE_API: "disabled" as const };

		it("読み込みを 403 で断る", async () => {
			const response = await app.request("/api/pages/api-disabled", {}, disabled);

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "page-api-disabled" });
		});

		it("書き込みを 403 で断り、何も保存しない", async () => {
			const response = await app.request(
				"/api/pages/api-disabled/commits",
				{ method: "POST", body: JSON.stringify({ id: commitId(), changes: [insertTitle] }) },
				disabled,
			);

			expect(response.status).toBe(403);
			expect(await (await get("/api/pages/api-disabled")).json()).toEqual({
				version: 0,
				lines: [],
			});
		});
	});
});

describe("ページの WebSocket", () => {
	const insert = (id: string) => ({
		type: "insert",
		line: { id, text: id },
		after: null,
		before: null,
	});
	const commitFrom = (page: string, client: string, change: unknown) =>
		post(`/api/pages/${page}/commits`, { id: commitId(), changes: [change], client });

	/** WebSocket で接続し、届いたメッセージを集める。 */
	async function connect(page: string, client: string) {
		const response = await exports.default.fetch(
			`https://amime.test/api/pages/${page}/socket?client=${client}`,
			{ headers: { Upgrade: "websocket" } },
		);
		const socket = response.webSocket;
		if (!socket) throw new Error(`upgrade failed: ${response.status}`);
		socket.accept();
		const messages: unknown[] = [];
		const closes: number[] = [];
		socket.addEventListener("message", ({ data }) => {
			messages.push(data === "pong" ? data : JSON.parse(String(data)));
		});
		socket.addEventListener("close", ({ code }) => closes.push(code));
		return { socket, messages, closes };
	}

	it("接続すると、いまのバージョンが届く", async () => {
		await commitFrom("ws-hello", "writer", insert("a"));

		const { messages } = await connect("ws-hello", "reader");

		await vi.waitFor(() => expect(messages).toEqual([{ type: "hello", version: 1 }]));
	});

	it("他の端末のコミットが届く。送った本人には配信しない(応答で受け取るため)", async () => {
		const reader = await connect("ws-broadcast", "reader");
		const writer = await connect("ws-broadcast", "writer");

		await commitFrom("ws-broadcast", "writer", insert("a"));

		await vi.waitFor(() =>
			expect(reader.messages).toEqual([
				{ type: "hello", version: 0 },
				{ type: "commit", version: 1, applied: [insert("a")] },
			]),
		);
		expect(writer.messages).toEqual([{ type: "hello", version: 0 }]);
	});

	it("台帳への知らせの予約に失敗しても、保存したコミットは配信する", async () => {
		const reader = await connect("ws-alarm-fails", "reader");
		const stub = exports.PageDO.getByName("default/ws-alarm-fails");
		await runInDurableObject(stub, (_instance, state) => {
			vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm failed"));
		});

		const response = await commitFrom("ws-alarm-fails", "writer", insert("a"));

		// 保存はできている。応答は失敗になり、端末は同じコミットを送り直す。
		expect(response.status).toBe(500);
		await vi.waitFor(() =>
			expect(reader.messages.at(-1)).toMatchObject({ type: "commit", version: 1 }),
		);
	});

	it("送り直された同じコミットは、配信しない", async () => {
		const reader = await connect("ws-duplicate", "reader");
		const body = { id: "ws-retry", changes: [insert("a")], client: "writer" };

		await post("/api/pages/ws-duplicate/commits", body);
		await post("/api/pages/ws-duplicate/commits", body);
		await commitFrom("ws-duplicate", "writer", insert("b"));

		await vi.waitFor(() => expect(reader.messages).toHaveLength(3));
		expect(reader.messages.map((message) => (message as { version?: number }).version)).toEqual([
			0, 1, 2,
		]);
	});

	it("何も効かなかったコミットは配信しない", async () => {
		const reader = await connect("ws-no-op", "reader");

		await commitFrom("ws-no-op", "writer", { type: "delete", id: "missing" });
		await commitFrom("ws-no-op", "writer", insert("a"));

		await vi.waitFor(() => expect(reader.messages).toHaveLength(2));
		expect(reader.messages[1]).toMatchObject({ type: "commit", version: 1 });
	});

	it("メモリから追い出されたあとでも、接続は保たれ、コミットが届く(休止からの復帰)", async () => {
		const reader = await connect("ws-hibernate", "reader");
		await evictDurableObject(exports.PageDO.getByName("default/ws-hibernate"), {
			webSockets: "hibernate",
		});

		await commitFrom("ws-hibernate", "writer", insert("a"));

		await vi.waitFor(() =>
			expect(reader.messages.at(-1)).toMatchObject({ type: "commit", version: 1 }),
		);
	});

	it("ping を送ると pong が返る(接続が生きていることの確認)", async () => {
		const { socket, messages } = await connect("ws-ping", "reader");

		socket.send("ping");

		await vi.waitFor(() => expect(messages).toContain("pong"));
	});

	it("決めていないメッセージを送ってきた接続は閉じる", async () => {
		const { socket, closes } = await connect("ws-unexpected", "reader");

		socket.send("hello?");

		await vi.waitFor(() => expect(closes).toEqual([1008]));
	});

	describe("他の人のカーソル(ADR-0023)", () => {
		const cursor = (line: string, column: number) => ({ line, column });
		const sendCursor = (socket: WebSocket, position: unknown) =>
			socket.send(JSON.stringify({ type: "cursor", cursor: position }));
		const hello = { type: "hello", version: 0 };

		it("カーソルの位置を送ると、他の端末に届く。本人には届かない", async () => {
			const alice = await connect("cursor-move", "alice");
			const bob = await connect("cursor-move", "bob");

			sendCursor(alice.socket, cursor("a", 3));

			await vi.waitFor(() =>
				expect(bob.messages).toEqual([
					hello,
					{ type: "cursor", client: "alice", cursor: cursor("a", 3) },
				]),
			);
			expect(alice.messages).toEqual([hello]);
		});

		it("カーソルを出すのをやめたこと(null)も届く", async () => {
			const alice = await connect("cursor-hide", "alice");
			const bob = await connect("cursor-hide", "bob");

			sendCursor(alice.socket, cursor("a", 3));
			sendCursor(alice.socket, null);

			await vi.waitFor(() =>
				expect(bob.messages.at(-1)).toEqual({ type: "cursor", client: "alice", cursor: null }),
			);
		});

		it("あとから接続した端末に、いまいる端末のカーソルが届く。カーソルを出していない端末の分は届かない", async () => {
			const alice = await connect("cursor-join", "alice");
			const carol = await connect("cursor-join", "carol");
			sendCursor(alice.socket, cursor("a", 3));
			sendCursor(carol.socket, cursor("b", 1));
			sendCursor(carol.socket, null);
			await vi.waitFor(() => expect(alice.messages).toHaveLength(3));

			const bob = await connect("cursor-join", "bob");

			await vi.waitFor(() =>
				expect(bob.messages).toEqual([
					hello,
					{ type: "cursor", client: "alice", cursor: cursor("a", 3) },
				]),
			);
		});

		it("メモリから追い出されたあとでも、カーソルの位置を覚えている(休止からの復帰)", async () => {
			const alice = await connect("cursor-hibernate", "alice");
			const watcher = await connect("cursor-hibernate", "watcher");
			sendCursor(alice.socket, cursor("a", 3));
			await vi.waitFor(() => expect(watcher.messages).toHaveLength(2));
			await evictDurableObject(exports.PageDO.getByName("default/cursor-hibernate"), {
				webSockets: "hibernate",
			});

			const bob = await connect("cursor-hibernate", "bob");

			await vi.waitFor(() =>
				expect(bob.messages).toContainEqual({
					type: "cursor",
					client: "alice",
					cursor: cursor("a", 3),
				}),
			);
		});

		it("接続が閉じると、他の端末に知らせる", async () => {
			const alice = await connect("cursor-leave", "alice");
			const bob = await connect("cursor-leave", "bob");

			alice.socket.close(1000, "bye");

			await vi.waitFor(() =>
				expect(bob.messages).toEqual([hello, { type: "leave", client: "alice" }]),
			);
		});

		it("同じ端末の接続が他にも残っていれば、閉じたことを知らせない(つなぎ直しの途中)", async () => {
			const first = await connect("cursor-reconnect", "alice");
			await connect("cursor-reconnect", "alice");
			const bob = await connect("cursor-reconnect", "bob");

			first.socket.close(1000, "replaced");
			// 知らせが来ないことを確かめるために、あとから別の知らせを起こして、それが先に届くのを待つ。
			const carol = await connect("cursor-reconnect", "carol");
			sendCursor(carol.socket, cursor("a", 0));

			await vi.waitFor(() => expect(bob.messages).toHaveLength(2));
			expect(bob.messages).toEqual([
				hello,
				{ type: "cursor", client: "carol", cursor: cursor("a", 0) },
			]);
		});

		it("同じ端末の接続がいくつかあっても、最後に知らせてきた位置だけを伝える", async () => {
			// つなぎ直しの途中で、前の接続が残っている。新しい接続で、カーソルを出すのをやめた。
			const former = await connect("cursor-twice", "alice");
			sendCursor(former.socket, cursor("a", 3));
			const current = await connect("cursor-twice", "alice");
			sendCursor(current.socket, null);
			const watcher = await connect("cursor-twice", "watcher");
			sendCursor(watcher.socket, cursor("b", 0));
			await vi.waitFor(() => expect(current.messages).toHaveLength(2));

			const bob = await connect("cursor-twice", "bob");

			await vi.waitFor(() => expect(bob.messages).toHaveLength(2));
			expect(bob.messages).toEqual([
				hello,
				{ type: "cursor", client: "watcher", cursor: cursor("b", 0) },
			]);
		});

		it("同じ端末の接続がいくつかあっても、その端末のカーソルは1つだけ伝える", async () => {
			const former = await connect("cursor-once", "alice");
			sendCursor(former.socket, cursor("a", 3));
			const current = await connect("cursor-once", "alice");
			sendCursor(current.socket, cursor("a", 5));
			const watcher = await connect("cursor-once", "watcher");
			await vi.waitFor(() => expect(watcher.messages).toHaveLength(2));

			expect(watcher.messages).toEqual([
				hello,
				{ type: "cursor", client: "alice", cursor: cursor("a", 5) },
			]);
		});

		it("形の違うカーソルを送ってきた接続は閉じる", async () => {
			const { socket, closes } = await connect("cursor-invalid", "reader");

			sendCursor(socket, { line: "a b", column: 0 });

			await vi.waitFor(() => expect(closes).toEqual([1008]));
		});
	});

	it("WebSocket への切り替えでない要求は 426 で断る", async () => {
		const response = await get("/api/pages/ws-plain/socket?client=reader");

		expect(response.status).toBe(426);
	});

	it.each([
		["ない", ""],
		["使えない文字を含む", "?client=a%20b"],
	])("端末の識別子が%s接続は 400 で断る", async (_name, query) => {
		const response = await exports.default.fetch(
			`https://amime.test/api/pages/ws-client/socket${query}`,
			{ headers: { Upgrade: "websocket" } },
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid-client" });
	});

	it("ページのAPIが無効な環境では、接続を 403 で断る", async () => {
		const response = await app.request(
			"/api/pages/ws-disabled/socket?client=reader",
			{ headers: { Upgrade: "websocket" } },
			{ ...env, PAGE_API: "disabled" as const },
		);

		expect(response.status).toBe(403);
	});
});

describe("他のサイトからの要求", () => {
	const foreign = { Origin: "https://evil.example" };
	const change = { type: "insert", line: { id: "a", text: "a" }, after: null, before: null };

	it("他のサイトのページからの書き込みは 403 で断り、何も保存しない", async () => {
		const response = await exports.default.fetch(
			"https://amime.test/api/pages/origin-post/commits",
			{
				method: "POST",
				headers: foreign,
				body: JSON.stringify({ id: commitId(), changes: [change] }),
			},
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "cross-origin" });
		expect(await (await get("/api/pages/origin-post")).json()).toMatchObject({ version: 0 });
	});

	it("他のサイトのページからの WebSocket の接続は 403 で断る(他のサイトに編集内容を読ませない)", async () => {
		const response = await exports.default.fetch(
			"https://amime.test/api/pages/origin-socket/socket?client=reader",
			{ headers: { Upgrade: "websocket", ...foreign } },
		);

		expect(response.status).toBe(403);
	});

	it("同じサイトのページからの要求は受け付ける", async () => {
		const same = { Origin: "https://amime.test" };

		const commit = await exports.default.fetch("https://amime.test/api/pages/origin-same/commits", {
			method: "POST",
			headers: same,
			body: JSON.stringify({ id: commitId(), changes: [change] }),
		});
		const socket = await exports.default.fetch(
			"https://amime.test/api/pages/origin-same/socket?client=reader",
			{ headers: { Upgrade: "websocket", ...same } },
		);

		expect(commit.status).toBe(200);
		expect(socket.status).toBe(101);
	});

	it("同じホストでも、http と https の違うサイトからの要求は断る", async () => {
		const response = await exports.default.fetch(
			"https://amime.test/api/pages/origin-scheme/commits",
			{
				method: "POST",
				headers: { Origin: "http://amime.test" },
				body: JSON.stringify({ id: commitId(), changes: [change] }),
			},
		);

		expect(response.status).toBe(403);
	});

	it("Origin が URL として読めない要求は断る", async () => {
		const response = await exports.default.fetch(
			"https://amime.test/api/pages/origin-bad/commits",
			{
				method: "POST",
				headers: { Origin: "null" },
				body: JSON.stringify({ id: commitId(), changes: [change] }),
			},
		);

		expect(response.status).toBe(403);
	});
});
