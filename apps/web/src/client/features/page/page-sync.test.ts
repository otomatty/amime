import { applyChanges, type Change, type Line, type LineId } from "@amime/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function start(server: ReturnType<typeof createServer>) {
	const states: PageSyncState[] = [];
	const sync = createPageSync({
		snapshot: server.snapshot(),
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
