import { applyChanges, type Change, type Line, type LineId } from "@amime/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageApiError } from "./page-api-error.ts";
import { createPageSync, type PageSyncState, SAVE_DELAY_MS } from "./page-sync.ts";

const line = (id: string, text: string = id.toUpperCase()): Line => ({ id: id as LineId, text });

/** サーバーの代わり。コミットを受け取った順に適用する。失敗させることもできる。 */
function createServer(initial: readonly Line[] = []) {
	let state = { version: 0, lines: initial };
	const server = {
		failing: false,
		commits: [] as (readonly Change[])[],
		snapshot: () => state,
		/** 他の人のコミットを入れる。 */
		commitFromOther(changes: readonly Change[]) {
			const result = applyChanges(state.lines, changes);
			state = { version: state.version + 1, lines: result.lines };
		},
		api: {
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

function start(server: ReturnType<typeof createServer>, initial?: readonly Line[]) {
	const states: PageSyncState[] = [];
	const sync = createPageSync({
		snapshot: server.snapshot(),
		initial: initial ?? server.snapshot().lines,
		api: server.api,
		onState: (state) => states.push(state),
	});
	return { sync, states, latest: () => states.at(-1) };
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
			remote: { lines: [line("x"), line("a", "A2")], base: local },
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
		const typedDuringReload = [line("a", "A2"), line("b")];
		sync.edit(typedDuringReload);
		release();
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		expect(latest()?.remote).toEqual({
			lines: [line("x"), line("a", "A2"), line("b")],
			base: typedDuringReload,
		});
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
		expect(latest()).toMatchObject({ status: "saved", remote: { lines: local } });
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
