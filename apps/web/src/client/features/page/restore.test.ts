import type {
	Change,
	Commit,
	CommitId,
	CommitResult,
	Line,
	LineId,
	PendingEntry,
} from "@amime/sync";
import { describe, expect, it, vi } from "vitest";
import { PageApiError } from "./page-api-error.ts";
import { restorePage } from "./restore.ts";

const line = (id: string, text: string): Line => ({ id: id as LineId, text });
const update = (id: string, text: string): Change => ({ type: "update", id: id as LineId, text });
const commit = (id: string, ...changes: Change[]): Commit => ({ id: id as CommitId, changes });

function setup(entries: PendingEntry[]) {
	const snapshot = { version: 3, lines: [line("a", "A"), line("b", "B")] };
	const api = {
		load: vi.fn(async () => snapshot),
		commit: vi.fn(
			async (sent: Commit): Promise<CommitResult> => ({ version: 4, applied: sent.changes }),
		),
	};
	return { snapshot, api, pending: { adopt: async () => entries } };
}

describe("restorePage", () => {
	it("残っている変更がなければ、読み込んだページをそのまま返す", async () => {
		const { snapshot, api, pending } = setup([]);

		expect(await restorePage(api, pending)).toEqual({ snapshot, restored: null, noticed: false });
		expect(api.commit).not.toHaveBeenCalled();
	});

	it("まだ送っていなかった変更を、読み込んだページに載せる", async () => {
		const { api, pending } = setup([{ inflight: null, changes: [update("a", "A2")] }]);

		expect(await restorePage(api, pending)).toMatchObject({
			restored: [line("a", "A2"), line("b", "B")],
			noticed: true,
		});
	});

	it("閉じたタブが送信中だったコミットは、ページを読み込む前に、同じIDで送り直す", async () => {
		const inflight = commit("c1", update("a", "A2"));
		const { api, pending } = setup([{ inflight, changes: [] }]);
		const order: string[] = [];
		api.commit.mockImplementationOnce(async (sent) => {
			order.push("commit");
			return { version: 4, applied: sent.changes };
		});
		api.load.mockImplementationOnce(async () => {
			order.push("load");
			return { version: 4, lines: [line("a", "A2"), line("b", "B")] };
		});

		const result = await restorePage(api, pending);

		expect(api.commit).toHaveBeenCalledExactlyOnceWith(inflight);
		expect(order).toEqual(["commit", "load"]);
		// 送り直したコミットは、読み込んだページに入っている。画面に載せ直す変更はない。
		expect(result).toMatchObject({ restored: null, noticed: true });
	});

	it("送り直したコミットが、以前にサーバーに入っていたものなら、復元したとは伝えない", async () => {
		const { api, pending } = setup([{ inflight: commit("c1", update("a", "A2")), changes: [] }]);
		api.commit.mockResolvedValueOnce({ version: 3, applied: [], duplicate: true });

		expect(await restorePage(api, pending)).toMatchObject({ restored: null, noticed: false });
	});

	it("複数の記録は、順に送り直し、順に載せる", async () => {
		const { api, pending } = setup([
			{ inflight: commit("c1", update("a", "1")), changes: [update("b", "1")] },
			{ inflight: commit("c2", update("a", "2")), changes: [update("b", "2")] },
		]);
		api.load.mockResolvedValueOnce({ version: 5, lines: [line("a", "2"), line("b", "B")] });

		const result = await restorePage(api, pending);

		expect(api.commit.mock.calls.map(([sent]) => sent.id)).toEqual(["c1", "c2"]);
		expect(result.restored).toEqual([line("a", "2"), line("b", "2")]);
	});

	describe("記録が複数あるとき、古い記録のまだ送っていなかった変更と、新しい記録の送信中だったコミット", () => {
		// 古い記録の変更はまだ画面の上にしかないのに、新しい記録のコミットは先にサーバーに入る。
		// そのまま載せると、古い変更が新しい変更に勝ってしまう。
		const three = [line("a", "A"), line("b", "B"), line("c", "C")];
		const cToTop: Change = { type: "move", id: "c" as LineId, after: null, before: "a" as LineId };
		const cAfterA: Change = {
			type: "move",
			id: "c" as LineId,
			after: "a" as LineId,
			before: "b" as LineId,
		};

		it("行の並べ替えは、新しい記録のものが勝つ", async () => {
			const { api, pending } = setup([
				{ inflight: null, changes: [cToTop, update("b", "B2")] },
				{ inflight: commit("c2", cAfterA), changes: [] },
			]);
			api.load.mockResolvedValueOnce({
				version: 4,
				lines: [line("a", "A"), line("c", "C"), line("b", "B")],
			});

			expect(await restorePage(api, pending)).toMatchObject({
				restored: [line("a", "A"), line("c", "C"), line("b", "B2")],
				noticed: true,
			});
		});

		it("載せた結果が読み込んだページと同じなら、載せ直す変更はない", async () => {
			const { api, pending } = setup([
				{ inflight: null, changes: [cToTop] },
				{ inflight: commit("c2", cAfterA), changes: [] },
			]);
			api.load.mockResolvedValueOnce({
				version: 4,
				lines: [line("a", "A"), line("c", "C"), line("b", "B")],
			});

			expect(await restorePage(api, pending)).toMatchObject({ restored: null, noticed: true });
		});

		it("新しい記録のコミットが以前にサーバーに入っていたものなら、古い記録の変更が後になる", async () => {
			// 以前に入っていたコミットを画面に載せ直すと、そのあとに他の人がした変更を上書きしてしまう。
			const { api, pending } = setup([
				{ inflight: null, changes: [update("b", "B2")] },
				{ inflight: commit("c2", cAfterA), changes: [] },
			]);
			api.commit.mockResolvedValueOnce({ version: 9, applied: [], duplicate: true });
			// コミットが入ったあとで、他の人が c を末尾に戻した。
			api.load.mockResolvedValueOnce({ version: 9, lines: three });

			expect((await restorePage(api, pending)).restored).toEqual([
				line("a", "A"),
				line("b", "B2"),
				line("c", "C"),
			]);
		});

		it("同じ行の本文の書き換えは、どちらも残る。新しい記録の変更を2重に載せない(ADR-0022)", async () => {
			const typed = (text: string): Change => ({
				type: "update",
				id: "a" as LineId,
				text,
				base: "晴れ",
			});
			const { api, pending } = setup([
				{ inflight: null, changes: [typed("晴れです")] },
				{ inflight: commit("c2", typed("晴れだ")), changes: [] },
			]);
			api.load.mockResolvedValueOnce({ version: 4, lines: [line("a", "晴れだ"), line("b", "B")] });

			expect((await restorePage(api, pending)).restored).toEqual([
				line("a", "晴れだです"),
				line("b", "B"),
			]);
		});
	});

	it("サーバーに断られたコミットは、まだ送っていなかった変更として載せる", async () => {
		// 捨てると、書いたものが黙って消える。載せておけば、画面に残り、送れないことが表示される。
		const { api, pending } = setup([
			{ inflight: commit("c1", update("a", "長すぎる")), changes: [update("b", "B2")] },
		]);
		api.commit.mockRejectedValueOnce(new PageApiError("rejected"));

		expect(await restorePage(api, pending)).toMatchObject({
			restored: [line("a", "長すぎる"), line("b", "B2")],
			noticed: true,
		});
	});

	it("送り直しに失敗したら(通信できない)、読み込みの失敗にする", async () => {
		const { api, pending } = setup([{ inflight: commit("c1", update("a", "A2")), changes: [] }]);
		api.commit.mockRejectedValueOnce(new PageApiError("failed"));

		await expect(restorePage(api, pending)).rejects.toMatchObject({ kind: "failed" });
		expect(api.load).not.toHaveBeenCalled();
	});
});
