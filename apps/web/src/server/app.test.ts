import { evictDurableObject } from "cloudflare:test";
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

	it("ページ名は、空白と大文字小文字の違いを同じページとして扱う", async () => {
		await post(`/api/pages/${encodeURIComponent("API Title メモ")}/commits`, {
			id: commitId(),
			changes: [insertTitle],
		});

		const response = await get(`/api/pages/${encodeURIComponent("api_title メモ")}`);

		expect(await response.json()).toMatchObject({ version: 1 });
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

	it("長すぎるページ名は 400 で断る", async () => {
		const response = await get(`/api/pages/${"a".repeat(201)}`);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid-page-name" });
	});

	it("大きすぎる本文は 413 で断る", async () => {
		const response = await post("/api/pages/api-large/commits", "x".repeat(2 * 1024 * 1024 + 1));

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "commit-too-large" });
	});

	describe("ページのAPIが無効な環境(認証が入るまでの公開環境)", () => {
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
