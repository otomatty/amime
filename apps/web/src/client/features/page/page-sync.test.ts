import { applyChanges, type Change, type Line, type LineId } from "@amime/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiError } from "./page-api-error.ts";
import type { PageSocketHandlers } from "./page-socket.ts";
import { createPageSync, SAVE_DELAY_MS, type SyncStatus } from "./page-sync.ts";

const line = (id: string, text: string = id.toUpperCase()): Line => ({ id: id as LineId, text });

/** サーバーの代わり。コミットを受け取った順に適用する。失敗させることもできる。 */
function createServer(initial: readonly Line[] = []) {
	let state = { version: 0, lines: initial };
	const server = {
		failing: false,
		commits: [] as (readonly Change[])[],
		/** 接続している端末に届ける先。接続していなければ null。 */
		handlers: null as PageSocketHandlers | null,
		snapshot: () => state,
		/** 他の人のコミットを入れる。配信はしない(届け方は、テストごとに決める)。 */
		commitFromOther(changes: readonly Change[]) {
			const result = applyChanges(state.lines, changes);
			state = { version: state.version + 1, lines: result.lines };
			return { version: state.version, applied: result.applied };
		},
		api: {
			subscribe: vi.fn((handlers: PageSocketHandlers) => {
				server.handlers = handlers;
				return () => {
					server.handlers = null;
				};
			}),
			load: vi.fn(async () => state),
			commit: vi.fn(async (changes: readonly Change[]) => {
				if (server.failing) throw new Error("offline");
				server.commits.push(changes);
				const result = applyChanges(state.lines, changes);
				if (result.applied.length > 0) state = { version: state.version + 1, lines: result.lines };
				return { version: state.version, applied: result.applied };
			}),
		},
	};
	return server;
}

/** 保存の状態と、編集欄に最後に渡された文書(まだ渡されていなければ null)。 */
type Observed = { readonly status: SyncStatus; readonly remote: readonly Line[] | null };

function start(server: ReturnType<typeof createServer>, initial?: readonly Line[]) {
	const states: Observed[] = [];
	const remotes: (readonly Line[])[] = [];
	const sync = createPageSync({
		snapshot: server.snapshot(),
		initial: initial ?? server.snapshot().lines,
		api: server.api,
		onStatus: (status) => states.push({ status, remote: remotes.at(-1) ?? null }),
		onRemote: (lines) => remotes.push(lines),
	});
	const latest = (): Observed | undefined => {
		const status = states.at(-1)?.status;
		return status && { status, remote: remotes.at(-1) ?? null };
	};
	return { sync, states, remotes, latest };
}

describe("createPageSync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("編集すると未保存になり、少し待ってから保存して、保存済みになる", async () => {
		const server = createServer([line("a")]);
		const { sync, latest } = start(server);

		sync.edit([line("a", "A2")]);
		expect(latest()?.status).toBe("unsaved");
		expect(server.api.commit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		expect(server.snapshot().lines).toEqual([line("a", "A2")]);
		expect(latest()).toEqual({ status: "saved", remote: null });
	});

	it("続けて打っているあいだは待ち、打ち終わってからまとめて保存する", async () => {
		const server = createServer([line("a")]);
		const { sync } = start(server);

		sync.edit([line("a", "A2")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
		sync.edit([line("a", "A3")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
		expect(server.api.commit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(server.commits).toEqual([[{ type: "update", id: "a", text: "A3" }]]);
	});

	it("保存中に書き足した分は、保存が終わりしだい続けて保存する", async () => {
		const server = createServer([line("a")]);
		let release = () => {};
		server.api.commit.mockImplementationOnce(async (changes) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			server.commitFromOther(changes);
			return { version: 1, applied: changes };
		});
		const { sync, latest } = start(server);
		sync.edit([line("a", "A2")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		expect(latest()?.status).toBe("saving");

		sync.edit([line("a", "A2"), line("b")]);
		release();
		await vi.advanceTimersByTimeAsync(0);

		expect(server.snapshot().lines).toEqual([line("a", "A2"), line("b")]);
		expect(latest()?.status).toBe("saved");
	});

	it("他の人の変更が先に入っていたら、読み直して取り込み、編集欄に渡す文書を知らせる", async () => {
		const server = createServer([line("a")]);
		const { sync, latest } = start(server);
		server.commitFromOther([{ type: "insert", line: line("x"), after: null, before: null }]);
		const local = [line("a", "A2")];

		sync.edit(local);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		expect(server.api.load).toHaveBeenCalledOnce();
		expect(server.snapshot().lines).toEqual([line("x"), line("a", "A2")]);
		expect(latest()).toEqual({
			status: "saved",
			remote: [line("x"), line("a", "A2")],
		});
	});

	it("読み直しを待っているあいだに書いた分も、取り込みのときに失わない", async () => {
		const server = createServer([line("a")]);
		const { sync, latest } = start(server);
		server.commitFromOther([{ type: "insert", line: line("x"), after: null, before: null }]);
		let release = () => {};
		server.api.load.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return server.snapshot();
		});
		sync.edit([line("a", "A2")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		// 読み直しの応答を待っているあいだに、さらに書く。
		sync.edit([line("a", "A2"), line("b")]);
		release();
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		expect(latest()?.remote).toEqual([line("x"), line("a", "A2"), line("b")]);
		expect(server.snapshot().lines).toEqual([line("x"), line("a", "A2"), line("b")]);
		expect(latest()?.status).toBe("saved");
	});

	it("サーバーに断られた変更は、同じ内容を送り直さない。内容を直すと、もう一度保存を試みる", async () => {
		const server = createServer([line("a")]);
		server.api.commit.mockRejectedValueOnce(new PageApiError("rejected"));
		const { sync, latest } = start(server);

		sync.edit([line("a", "長すぎる行")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		expect(latest()?.status).toBe("rejected");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(server.api.commit).toHaveBeenCalledTimes(1);

		sync.edit([line("a", "短い行")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		expect(server.snapshot().lines).toEqual([line("a", "短い行")]);
		expect(latest()?.status).toBe("saved");
	});

	it("断られるまでのあいだに内容を直していたら、直した内容をそのまま保存する", async () => {
		const server = createServer([line("a")]);
		let reject = () => {};
		server.api.commit.mockImplementationOnce(
			() =>
				new Promise((_resolve, rejectCommit) => {
					reject = () => rejectCommit(new PageApiError("rejected"));
				}),
		);
		const { sync, latest } = start(server);
		sync.edit([line("a", "長すぎる行")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		sync.edit([line("a", "短い行")]);
		reject();
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		expect(server.snapshot().lines).toEqual([line("a", "短い行")]);
		expect(latest()?.status).toBe("saved");
	});

	it("応答が届かなかったコミットがサーバーに入っていたら、再試行で二重に送らず、読み直して追いつく", async () => {
		const server = createServer([line("a")]);
		server.api.commit.mockImplementationOnce(async (changes) => {
			server.commitFromOther(changes); // サーバーには入ったが、応答は届かなかった
			throw new PageApiError("failed");
		});
		const { sync, latest } = start(server);
		const local = [line("a", "A2")];
		sync.edit(local);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		expect(latest()?.status).toBe("retrying");

		// 取り消して元に戻しても、送った変更の行方が分かるまでは「保存済み」にしない。
		sync.edit([line("a")]);
		expect(latest()?.status).toBe("retrying");
		await vi.advanceTimersByTimeAsync(1000);

		expect(server.api.load).toHaveBeenCalledOnce();
		expect(server.api.commit).toHaveBeenCalledTimes(1);
		expect(latest()).toEqual({ status: "saved", remote: local });
	});

	it("再試行のときの読み直しにも失敗したら、さらに間隔を延ばして再試行する", async () => {
		const server = createServer([line("a")]);
		server.failing = true;
		server.api.load.mockRejectedValueOnce(new PageApiError("failed"));
		const { sync, latest } = start(server);
		sync.edit([line("a", "A2")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 1000);
		expect(latest()?.status).toBe("retrying");

		server.failing = false;
		await vi.advanceTimersByTimeAsync(2000);

		expect(server.snapshot().lines).toEqual([line("a", "A2")]);
		expect(latest()?.status).toBe("saved");
	});

	describe("まだないページ", () => {
		const initial = [line("t", "新しいページ")];

		it("最初に表示した内容のままなら、保存しない(開いただけではページを作らない)", async () => {
			const server = createServer();
			const { sync, latest } = start(server, initial);

			// 1文字打って、保存が始まる前に取り消した。
			sync.edit([line("t", "新しいページa")]);
			expect(latest()?.status).toBe("unsaved");
			sync.edit([line("t", "新しいページ")]);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(latest()?.status).toBe("new");
			expect(server.api.commit).not.toHaveBeenCalled();
		});

		it("内容を変えると、最初に表示したタイトルの行も含めて保存する", async () => {
			const server = createServer();
			const { sync, latest } = start(server, initial);

			sync.edit([...initial, line("b", "本文")]);
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

			expect(server.snapshot().lines).toEqual([...initial, line("b", "本文")]);
			expect(latest()?.status).toBe("saved");
		});

		it("保存したあとは、最初の内容に戻しても、それを保存する", async () => {
			const server = createServer();
			const { sync, latest } = start(server, initial);
			sync.edit([...initial, line("b", "本文")]);
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

			sync.edit(initial);
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

			expect(server.snapshot().lines).toEqual(initial);
			expect(latest()?.status).toBe("saved");
		});
	});

	it("保存に失敗したら、間隔を延ばしながら再試行し、つながれば保存する", async () => {
		const server = createServer([line("a")]);
		server.failing = true;
		const { sync, latest } = start(server);

		sync.edit([line("a", "A2")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		expect(latest()?.status).toBe("retrying");
		expect(server.api.commit).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(server.api.commit).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1999);
		expect(server.api.commit).toHaveBeenCalledTimes(2);

		server.failing = false;
		await vi.advanceTimersByTimeAsync(1);

		expect(server.snapshot().lines).toEqual([line("a", "A2")]);
		expect(latest()?.status).toBe("saved");
	});

	it("flush を呼ぶと、待たずにすぐ保存を試みる(通信が戻ったとき)", async () => {
		const server = createServer([line("a")]);
		server.failing = true;
		const { sync, latest } = start(server);
		sync.edit([line("a", "A2")]);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		server.failing = false;

		sync.flush();
		await vi.advanceTimersByTimeAsync(0);

		expect(latest()?.status).toBe("saved");
		// 予約してあった再試行は、送るものがないので何も送らない。
		await vi.advanceTimersByTimeAsync(60_000);
		expect(server.commits).toHaveLength(1);
	});

	describe("他の人のコミットの配信", () => {
		const insertX: Change = { type: "insert", line: line("x"), after: null, before: null };

		it("届いたコミットを取り込み、編集欄に渡す文書を知らせる。読み直しはしない", () => {
			const server = createServer([line("a")]);
			const { latest } = start(server);

			server.handlers?.onCommit(server.commitFromOther([insertX]));

			expect(latest()).toEqual({
				status: "saved",
				remote: [line("x"), line("a")],
			});
			expect(server.api.load).not.toHaveBeenCalled();
		});

		it("まだ送っていない自分の編集は残り、そのあと保存される", async () => {
			const server = createServer([line("a")]);
			const { sync, latest } = start(server);
			sync.edit([line("a", "A2")]);

			server.handlers?.onCommit(server.commitFromOther([insertX]));
			expect(latest()?.remote).toEqual([line("x"), line("a", "A2")]);
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

			expect(server.snapshot().lines).toEqual([line("x"), line("a", "A2")]);
			expect(latest()?.status).toBe("saved");
			expect(server.api.load).not.toHaveBeenCalled();
		});

		it("保存の応答を待っているあいだに届いても、読み直さずに両方を反映する", async () => {
			const server = createServer([line("a")]);
			let respond = () => {};
			server.api.commit.mockImplementationOnce(
				(changes) =>
					new Promise((resolve) => {
						// 他の人のコミットが先にサーバーに入り、そのあとで自分のコミットが入った。
						const other = server.commitFromOther([insertX]);
						const mine = server.commitFromOther(changes);
						server.handlers?.onCommit(other);
						respond = () => resolve(mine);
					}),
			);
			const { sync, latest } = start(server);
			sync.edit([line("a", "A2")]);
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
			expect(latest()?.status).toBe("saving");

			respond();
			await vi.advanceTimersByTimeAsync(0);

			expect(latest()).toMatchObject({
				status: "saved",
				remote: [line("x"), line("a", "A2")],
			});
			expect(server.api.load).not.toHaveBeenCalled();
		});

		it("続けて届いたコミットを、届いた順にすべて編集欄へ渡す。自分からは何も送らない", async () => {
			const server = createServer([line("a")]);
			const { remotes } = start(server);
			const insertY: Change = {
				type: "insert",
				line: line("y"),
				after: line("x").id,
				before: null,
			};

			server.handlers?.onCommit(server.commitFromOther([insertX]));
			server.handlers?.onCommit(server.commitFromOther([insertY]));
			await vi.advanceTimersByTimeAsync(60_000);

			expect(remotes).toEqual([
				[line("x"), line("a")],
				[line("x"), line("y"), line("a")],
			]);
			expect(server.api.commit).not.toHaveBeenCalled();
		});

		it("何も効かなかった保存のあとの読み直しが、配信より遅れて届いても、文書を巻き戻さない", async () => {
			const server = createServer([line("a")]);
			const { sync, latest } = start(server);
			// 他の人が、自分と同じ変更を先に保存していた(バージョン1)。自分の保存は何も効かない。
			const same = server.commitFromOther([{ type: "update", id: line("a").id, text: "A2" }]);
			let release = () => {};
			server.api.load.mockImplementationOnce(async () => {
				const stale = server.snapshot();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return stale;
			});
			sync.edit([line("a", "A2")]);
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
			expect(server.api.load).toHaveBeenCalledOnce();

			// 読み直しを待っているあいだに、配信でバージョン2まで進んだ。
			server.handlers?.onCommit(same);
			server.handlers?.onCommit(server.commitFromOther([insertX]));
			release();
			await vi.advanceTimersByTimeAsync(0);

			expect(latest()).toEqual({ status: "saved", remote: [line("x"), line("a", "A2")] });
		});

		it("追いつくための読み直しより先のコミットがあると分かっていたら、そこに届くまで読み直す", async () => {
			const server = createServer([line("a")]);
			const { latest } = start(server);
			server.commitFromOther([insertX]); // バージョン1。届かなかった
			let release = () => {};
			server.api.load.mockImplementationOnce(async () => {
				const stale = server.snapshot();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return stale;
			});
			server.handlers?.onHello(1);
			await vi.advanceTimersByTimeAsync(0);

			// 読み直しを待っているあいだに、バージョン2は届かず、バージョン3だけが届いた。
			server.commitFromOther([{ type: "update", id: line("a").id, text: "A2" }]);
			server.handlers?.onCommit(
				server.commitFromOther([{ type: "update", id: line("x").id, text: "X2" }]),
			);
			release();
			await vi.advanceTimersByTimeAsync(0);

			expect(server.api.load).toHaveBeenCalledTimes(2);
			expect(latest()?.remote).toEqual([line("x", "X2"), line("a", "A2")]);
		});

		it("あいだのコミットを受け取りそこねていたら、読み直して追いつく", async () => {
			const server = createServer([line("a")]);
			const { latest } = start(server);
			server.commitFromOther([insertX]); // これは届かなかった

			server.handlers?.onCommit(server.commitFromOther([{ type: "delete", id: line("a").id }]));
			await vi.advanceTimersByTimeAsync(0);

			expect(server.api.load).toHaveBeenCalledOnce();
			expect(latest()).toEqual({ status: "saved", remote: [line("x")] });
		});

		it("接続したときにサーバーのほうが進んでいたら、読み直して追いつく(つなぎ直したとき)", async () => {
			const server = createServer([line("a")]);
			const { latest } = start(server);
			server.commitFromOther([insertX]);

			server.handlers?.onHello(server.snapshot().version);
			await vi.advanceTimersByTimeAsync(0);

			expect(latest()?.remote).toEqual([line("x"), line("a")]);
		});

		it("接続したときに同じバージョンなら、読み直さない", async () => {
			const server = createServer([line("a")]);
			start(server);

			server.handlers?.onHello(server.snapshot().version);
			await vi.advanceTimersByTimeAsync(0);

			expect(server.api.load).not.toHaveBeenCalled();
		});

		it("追いつくための読み直しに失敗したら、再試行する", async () => {
			const server = createServer([line("a")]);
			const { latest } = start(server);
			server.commitFromOther([insertX]);
			server.api.load.mockRejectedValueOnce(new PageApiError("failed"));

			server.handlers?.onHello(server.snapshot().version);
			await vi.advanceTimersByTimeAsync(1000);

			expect(server.api.load).toHaveBeenCalledTimes(2);
			expect(latest()?.remote).toEqual([line("x"), line("a")]);
		});

		it("まだないページを開いているあいだに他の人が書いたら、仮のタイトルを捨てて、その内容を表示する", async () => {
			const server = createServer();
			const initial = [line("t", "新しいページ")];
			const { latest } = start(server, initial);

			server.handlers?.onCommit(server.commitFromOther([insertX]));
			await vi.advanceTimersByTimeAsync(60_000);

			expect(latest()).toEqual({ status: "saved", remote: [line("x")] });
			expect(server.api.commit).not.toHaveBeenCalled();
		});

		it("止めると、接続を閉じる", () => {
			const server = createServer([line("a")]);
			const { sync } = start(server);
			expect(server.handlers).not.toBeNull();

			sync.dispose();

			expect(server.handlers).toBeNull();
		});
	});

	it("読み直しを待っているあいだに止めたら、その読み直しが失敗しても再試行しない", async () => {
		const server = createServer([line("a")]);
		const { sync } = start(server);
		let fail = () => {};
		server.api.load.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = () => reject(new PageApiError("failed"));
				}),
		);
		server.handlers?.onHello(5);
		await vi.advanceTimersByTimeAsync(0);

		sync.dispose();
		fail();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(server.api.load).toHaveBeenCalledOnce();
	});

	it("止めたあとは、保存も通知もしない", async () => {
		const server = createServer([line("a")]);
		const { sync, states } = start(server);
		sync.edit([line("a", "A2")]);
		const count = states.length;

		sync.dispose();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(server.api.commit).not.toHaveBeenCalled();
		expect(states).toHaveLength(count);
	});
});
