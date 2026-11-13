import {
	applyChanges,
	type Change,
	type ClientId,
	type Commit,
	type CommitId,
	type CommitResult,
	type Line,
	type LineId,
	type PendingEntry,
} from "@amime/sync";
import { describe, expect, it, vi } from "vitest";
import { PageApiError } from "./page-api-error.ts";
import { restorePage } from "./restore.ts";

const id = (value: string) => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });
/** 本文を置き換える変更。from は、その変更が元にした本文。 */
const update = (lineId: string, text: string, from?: string): Change =>
	from === undefined
		? { type: "update", id: id(lineId), text }
		: { type: "update", id: id(lineId), text, base: from };
const remove = (lineId: string): Change => ({ type: "delete", id: id(lineId) });
const insert = (lineId: string, text: string, after: string | null): Change => ({
	type: "insert",
	line: line(lineId, text),
	after: after === null ? null : id(after),
	before: null,
});
/** 1つのコミットに入れられる変更の数の上限。 */
const MAX_CHANGES = 2000;
const commit = (commitId: string, ...changes: Change[]): Commit => ({
	id: commitId as CommitId,
	changes,
});

/**
 * サーバーの代わり。コミットを受け取った順に適用する。同じIDのコミットは、1度しか適用しない。
 * known は、以前に受け付けていたコミットのID。
 */
function setup(entries: PendingEntry[], known: readonly string[] = []) {
	let state: { version: number; lines: readonly Line[] } = {
		version: 3,
		lines: [line("a", "A"), line("b", "B")],
	};
	const seen = new Set<string>(known);
	const api = {
		load: vi.fn(async () => state),
		commit: vi.fn(async (sent: Commit): Promise<CommitResult> => {
			if (seen.has(sent.id)) return { version: state.version, applied: [], duplicate: true };
			seen.add(sent.id);
			const result = applyChanges(state.lines, sent.changes);
			if (result.applied.length > 0) state = { version: state.version + 1, lines: result.lines };
			return { version: state.version, applied: result.applied };
		}),
	};
	return {
		api,
		pending: { adopt: async () => entries },
		server: () => state,
		/** 他の人のコミットを入れる。 */
		commitFromOther(...changes: Change[]) {
			state = { version: state.version + 1, lines: applyChanges(state.lines, changes).lines };
		},
		sentIds: () => api.commit.mock.calls.map(([sent]) => sent.id),
	};
}

describe("restorePage", () => {
	it("残っている変更がなければ、読み込んだページをそのまま返す", async () => {
		const { api, pending, server } = setup([]);

		expect(await restorePage(api, pending)).toEqual({
			snapshot: server(),
			restored: null,
			noticed: false,
		});
		expect(api.commit).not.toHaveBeenCalled();
	});

	it("まだ送っていなかった変更を、読み込んだページに載せる(サーバーには、まだ送らない)", async () => {
		const { api, pending } = setup([{ inflight: null, changes: [update("a", "A2", "A")] }]);

		expect(await restorePage(api, pending)).toMatchObject({
			restored: [line("a", "A2"), line("b", "B")],
			noticed: true,
		});
		expect(api.commit).not.toHaveBeenCalled();
	});

	it("閉じたタブが送信中だったコミットは、ページを読み込む前に、同じIDで送り直す", async () => {
		const inflight = commit("c1", update("a", "A2", "A"));
		const { api, pending } = setup([{ inflight, changes: [] }]);

		const result = await restorePage(api, pending);

		expect(api.commit).toHaveBeenCalledExactlyOnceWith(inflight);
		expect(api.commit.mock.invocationCallOrder[0]).toBeLessThan(
			api.load.mock.invocationCallOrder[0] ?? 0,
		);
		// 送り直したコミットは、読み込んだページに入っている。画面に載せ直す変更はない。
		expect(result).toMatchObject({
			snapshot: { version: 4, lines: [line("a", "A2"), line("b", "B")] },
			restored: null,
			noticed: true,
		});
	});

	it("送り直したコミットが、以前にサーバーに入っていたものなら、何も起きない。復元したとは伝えない", async () => {
		const { api, pending, commitFromOther, server } = setup(
			[{ inflight: commit("c1", update("a", "A2", "A")), changes: [] }],
			["c1"],
		);
		// コミットが入ったあとで、他の人が同じ行を書き換えていた。その変更は残る。
		commitFromOther(update("a", "他の人の本文"));

		expect(await restorePage(api, pending)).toMatchObject({ restored: null, noticed: false });
		expect(server().lines).toEqual([line("a", "他の人の本文"), line("b", "B")]);
	});

	it("送り直しに失敗したら(通信できない)、読み込みの失敗にする", async () => {
		const { api, pending } = setup([
			{ inflight: commit("c1", update("a", "A2", "A")), changes: [] },
		]);
		api.commit.mockRejectedValueOnce(new PageApiError("failed"));

		await expect(restorePage(api, pending)).rejects.toMatchObject({ kind: "failed" });
		expect(api.load).not.toHaveBeenCalled();
	});

	it("サーバーに断られたコミットは、まだ送っていなかった変更として載せる", async () => {
		// 捨てると、書いたものが黙って消える。載せておけば、画面に残り、送れないことが表示される。
		const { api, pending } = setup([
			{ inflight: commit("c1", update("a", "長すぎる", "A")), changes: [update("b", "B2", "B")] },
		]);
		api.commit.mockRejectedValueOnce(new PageApiError("rejected"));

		expect(await restorePage(api, pending)).toMatchObject({
			restored: [line("a", "長すぎる"), line("b", "B2")],
			noticed: true,
		});
	});

	describe("記録が複数あるとき(いくつものタブが、未送信のまま閉じていた)", () => {
		it("古い記録から順に、1つずつサーバーに入れる。画面に載せるのは、最後の記録のまだ送っていなかった変更だけ", async () => {
			const { api, pending, server, sentIds } = setup([
				{ inflight: commit("c1", update("a", "A1", "A")), changes: [update("b", "B1", "B")] },
				{ inflight: commit("c2", insert("x", "X", "b")), changes: [update("x", "X2", "X")] },
			]);

			const result = await restorePage(api, pending);

			// 1つめの記録の送信中だったコミット、まだ送っていなかった変更、2つめの記録の送信中だったコミット。
			expect(sentIds()).toEqual(["c1", expect.stringMatching(/^r-[0-9a-f]{40}-0$/), "c2"]);
			expect(api.commit.mock.calls[1]?.[0].changes).toEqual([update("b", "B1", "B")]);
			expect(server().lines).toEqual([line("a", "A1"), line("b", "B1"), line("x", "X")]);
			expect(result).toMatchObject({
				snapshot: server(),
				restored: [line("a", "A1"), line("b", "B1"), line("x", "X2")],
				noticed: true,
			});
		});

		it("古い記録の変更が、新しい記録の変更を上書きしない(新しいほうが、あとから入る)", async () => {
			// どちらも、元にした本文を持たない書き換え(置き換え)。あとから入ったほうが残る。
			const { api, pending, server } = setup([
				{ inflight: null, changes: [update("a", "古い"), update("b", "B2")] },
				{ inflight: commit("c2", update("a", "新しい")), changes: [] },
			]);

			const result = await restorePage(api, pending);

			expect(server().lines).toEqual([line("a", "新しい"), line("b", "B2")]);
			expect(result).toMatchObject({ restored: null, noticed: true });
		});

		it("同じ行の本文の書き換えは、どちらも残る。足した文字は2重にならない(ADR-0022)", async () => {
			const { api, pending, server } = setup([
				{ inflight: null, changes: [update("a", "Aです", "A")] },
				{ inflight: commit("c2", update("a", "Aだ", "A")), changes: [] },
			]);

			await restorePage(api, pending);

			expect(server().lines).toEqual([line("a", "Aですだ"), line("b", "B")]);
		});

		it("古い記録が消して、次の記録が戻した行への書き換えも、順に入る", async () => {
			const { api, pending, server } = setup([
				{ inflight: null, changes: [remove("a")] },
				{ inflight: commit("c2", insert("a", "元の本文", null)), changes: [] },
				{ inflight: commit("c3", update("a", "新しい本文", "元の本文")), changes: [] },
			]);

			await restorePage(api, pending);

			expect(server().lines).toEqual([line("a", "新しい本文"), line("b", "B")]);
		});

		it("以前にサーバーに入っていたコミットは、もう一度は入らない。そのあとの他の人の変更は残る", async () => {
			const { api, pending, server, commitFromOther } = setup(
				[
					{ inflight: null, changes: [update("b", "B2", "B")] },
					{ inflight: commit("c2", update("a", "A2", "A")), changes: [] },
				],
				["c2"],
			);
			commitFromOther(update("a", "他の人の本文"));

			await restorePage(api, pending);

			expect(server().lines).toEqual([line("a", "他の人の本文"), line("b", "B2")]);
		});

		it("まだ送っていなかった変更に付けるIDは、記録の内容から決まる。復元をやり直しても、2度は入らない", async () => {
			const entries: PendingEntry[] = [
				{ inflight: null, changes: [insert("x", "X", "b")] },
				{ inflight: null, changes: [update("a", "A2", "A")] },
			];
			const first = setup(entries);
			await restorePage(first.api, first.pending);
			const [derived] = first.sentIds();

			// 同じ記録を、もう一度復元する(前の復元の途中で、タブが閉じた)。前に入れたコミットは、入っている。
			const second = setup(entries, derived === undefined ? [] : [derived]);
			await restorePage(second.api, second.pending);

			expect(second.sentIds()).toEqual([derived]);
			await expect(second.api.commit.mock.results[0]?.value).resolves.toMatchObject({
				duplicate: true,
			});
			// 重複として扱われ、何も入らない(このサーバーの代わりには、前の復元で入った行を入れていない)。
			expect(second.server().lines).toEqual([line("a", "A"), line("b", "B")]);
		});

		it("内容が同じでも、残した端末が違えば、別の変更として入れる", async () => {
			// 2つのタブが、それぞれ同じ行を足して消した…のではなく、たまたま同じ内容の変更を残した。
			const changes = [update("a", "A!", "A")];
			const { api, pending, sentIds } = setup([
				{ origin: "tab-1" as ClientId, inflight: null, changes },
				{ origin: "tab-2" as ClientId, inflight: null, changes },
				{ inflight: null, changes: [] },
			]);

			await restorePage(api, pending);

			const [first, second] = sentIds();
			expect(first).toMatch(/^r-[0-9a-f]{40}-0$/);
			expect(second).toMatch(/^r-[0-9a-f]{40}-0$/);
			expect(second).not.toBe(first);
		});

		it("記録のコミットがサーバーに断られたら、その記録の残りの変更は送らずに、順のまま画面に載せる", async () => {
			// 断られたコミットが足した行 x を、同じ記録のあとの変更が書き換えている。
			// あとの変更だけを送ると、サーバーには行 x がないので効かず、書き換えが失われる。
			const { api, pending, server, sentIds } = setup([
				{
					inflight: commit("c1", insert("x", "元の本文", "b"), update("a", "長すぎる", "A")),
					changes: [update("x", "新しい本文", "元の本文")],
				},
				{ inflight: commit("c2", update("b", "B2", "B")), changes: [] },
			]);
			api.commit.mockRejectedValueOnce(new PageApiError("rejected"));

			const result = await restorePage(api, pending);

			expect(sentIds()).toEqual(["c1", "c2"]);
			expect(server().lines).toEqual([line("a", "A"), line("b", "B2")]);
			expect(result.restored).toEqual([
				line("a", "長すぎる"),
				line("b", "B2"),
				line("x", "新しい本文"),
			]);
		});

		it("まだ送っていなかった変更が1つのコミットに収まらなければ、分けて入れる", async () => {
			const many = Array.from({ length: MAX_CHANGES + 1 }, (_, index) =>
				insert(`n${index}`, "x", null),
			);
			const { api, pending, server, sentIds } = setup([
				{ inflight: null, changes: many },
				{ inflight: null, changes: [] },
			]);

			await restorePage(api, pending);

			expect(sentIds()).toEqual([
				expect.stringMatching(/^r-[0-9a-f]{40}-0$/),
				expect.stringMatching(/^r-[0-9a-f]{40}-1$/),
			]);
			expect(api.commit.mock.calls.map(([sent]) => sent.changes.length)).toEqual([MAX_CHANGES, 1]);
			expect(server().lines).toHaveLength(MAX_CHANGES + 3);
		});

		it("サーバーに断られた変更は、画面に載せて残す。残りの記録は、そのまま入れる", async () => {
			const { api, pending, server } = setup([
				{ inflight: null, changes: [update("a", "長すぎる", "A")] },
				{ inflight: commit("c2", update("b", "B2", "B")), changes: [insert("x", "X", "b")] },
			]);
			api.commit.mockRejectedValueOnce(new PageApiError("rejected"));

			const result = await restorePage(api, pending);

			expect(server().lines).toEqual([line("a", "A"), line("b", "B2")]);
			expect(result.restored).toEqual([line("a", "長すぎる"), line("b", "B2"), line("x", "X")]);
		});

		it("途中で通信に失敗したら、読み込みの失敗にする(やり直せば、続きから入る)", async () => {
			const { api, pending } = setup([
				{ inflight: null, changes: [update("a", "A2", "A")] },
				{ inflight: commit("c2", update("b", "B2", "B")), changes: [] },
			]);
			api.commit.mockRejectedValueOnce(new PageApiError("failed"));

			await expect(restorePage(api, pending)).rejects.toMatchObject({ kind: "failed" });
			expect(api.load).not.toHaveBeenCalled();
		});
	});
});
