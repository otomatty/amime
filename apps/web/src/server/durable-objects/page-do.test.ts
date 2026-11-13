import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { applyChanges, type Change, type CommitId, type Line, type LineId } from "@amime/sync";
import { describe, expect, it } from "vitest";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });
let commitSerial = 0;
const nextCommitId = (): CommitId => {
	commitSerial += 1;
	return `test-${commitSerial}` as CommitId;
};
/** 新しいIDのコミットとして、変更を送る。 */
const commitTo = (stub: ReturnType<typeof page>, changes: readonly Change[]) =>
	stub.commit({ id: nextCommitId(), changes });

/** after に指定した行の直後(null なら先頭)に行を入れる。 */
const insertAfter = (after: string | null, lineId: string, text: string): Change => ({
	type: "insert",
	line: line(lineId, text),
	after: after === null ? null : id(after),
	before: null,
});

/** テストごとに別のページ(=別の Durable Object)を使い、状態を共有しない。 */
const page = (name: string) => exports.PageDO.getByName(`test-project/${name}`);

describe("PageDO", () => {
	it("新しいページは行を持たず、バージョンは0", async () => {
		expect(await page("empty").getPage()).toEqual({ version: 0, lines: [] });
	});

	it("コミットすると変更が適用され、バージョンが1つ進む", async () => {
		const stub = page("commit");

		const inserts = [insertAfter(null, "a", "タイトル"), insertAfter("a", "b", "本文")];
		const update: Change = { type: "update", id: id("b"), text: "本文2" };

		const first = await commitTo(stub, inserts);
		const second = await commitTo(stub, [update]);

		expect(first).toEqual({ version: 1, applied: inserts });
		expect(second).toEqual({ version: 2, applied: [update] });
		expect(await stub.getPage()).toEqual({
			version: 2,
			lines: [line("a", "タイトル"), line("b", "本文2")],
		});
	});

	it("同じ行を同時に書き換えたコミットは、文字単位で統合する(ADR-0022)", async () => {
		const stub = page("merge");
		const typed = (text: string): Change => ({
			type: "update",
			id: id("a"),
			text,
			base: "今日は👨‍👩‍👧と公園",
		});
		await commitTo(stub, [insertAfter(null, "a", "今日は👨‍👩‍👧と公園")]);

		// 2人が、同じ本文を元に、別々の場所を書き換えた。
		const first = await commitTo(stub, [typed("今日は👨‍👩‍👧と公園へ行く")]);
		const second = await commitTo(stub, [typed("たぶん今日は👨‍👩‍👧と動物園")]);

		expect(first.applied).toEqual([
			{ type: "update", id: id("a"), text: "今日は👨‍👩‍👧と公園へ行く" },
		]);
		// 効いた変更は、統合した結果への置き換えとして配る。絵文字は途中で切らない。
		expect(second.applied).toEqual([
			{ type: "update", id: id("a"), text: "たぶん今日は👨‍👩‍👧と動物園へ行く" },
		]);
		expect((await stub.getPage()).lines).toEqual([line("a", "たぶん今日は👨‍👩‍👧と動物園へ行く")]);
	});

	it("行の並び順を保つ", async () => {
		const stub = page("order");

		await commitTo(stub, [insertAfter(null, "c", "3"), insertAfter("c", "a", "1")]);
		await commitTo(stub, [insertAfter("c", "b", "2")]);
		await commitTo(stub, [{ type: "move", id: id("c"), after: id("a"), before: null }]);

		expect((await stub.getPage()).lines.map((l) => l.id)).toEqual(["b", "a", "c"]);
	});

	it("対象の行がなくなっている変更だけを捨て、残りを適用する。効いた変更を返す", async () => {
		const stub = page("lenient");
		await commitTo(stub, [insertAfter(null, "a", "A")]);
		const update: Change = { type: "update", id: id("a"), text: "A2" };

		const result = await commitTo(stub, [{ type: "delete", id: id("missing") }, update]);

		expect(result).toEqual({ version: 2, applied: [update] });
		expect(await stub.getPage()).toEqual({ version: 2, lines: [line("a", "A2")] });
	});

	it("何も効かなかったコミットでは、バージョンを進めない", async () => {
		const stub = page("no-op");
		await commitTo(stub, [insertAfter(null, "a", "A")]);

		const result = await commitTo(stub, [{ type: "delete", id: id("missing") }]);

		expect(result).toEqual({ version: 1, applied: [] });
		expect((await stub.getPage()).version).toBe(1);
	});

	it("ページごとに状態が独立している", async () => {
		await commitTo(page("isolated-1"), [insertAfter(null, "a", "A")]);

		expect(await page("isolated-2").getPage()).toEqual({ version: 0, lines: [] });
	});

	it("メモリから追い出されても、保存した内容から復元できる", async () => {
		const stub = page("durable");
		await commitTo(stub, [insertAfter(null, "a", "A")]);

		await evictDurableObject(stub);

		expect(await stub.getPage()).toEqual({ version: 1, lines: [line("a", "A")] });
	});

	describe("同じコミットの送り直し", () => {
		const commit = { id: "retry-1" as CommitId, changes: [insertAfter(null, "a", "A")] };

		it("同じIDのコミットは、1度しか適用しない。2度目は、重複だと分かる応答を返す", async () => {
			const stub = page("duplicate");

			const first = await stub.commit(commit);
			const second = await stub.commit(commit);

			expect(first).toEqual({ version: 1, applied: commit.changes });
			expect(second).toEqual({ version: 1, applied: [], duplicate: true });
			expect(await stub.getPage()).toEqual({ version: 1, lines: [line("a", "A")] });
		});

		it("送り直すまでのあいだに他のコミットが入っていても、重複だと分かる。応答のバージョンは、いまのバージョン", async () => {
			const stub = page("duplicate-later");
			await stub.commit(commit);
			await commitTo(stub, [{ type: "update", id: id("a"), text: "A2" }]);

			expect(await stub.commit(commit)).toEqual({ version: 2, applied: [], duplicate: true });
			expect((await stub.getPage()).lines).toEqual([line("a", "A2")]);
		});

		it("何も効かなかったコミットも覚えておく(送り直しで、あとから効いてしまわないように)", async () => {
			const stub = page("duplicate-no-op");
			const update = {
				id: "retry-2" as CommitId,
				changes: [{ type: "update", id: id("a"), text: "A2" }] as const,
			};
			await stub.commit(update);
			await commitTo(stub, [insertAfter(null, "a", "A")]);

			expect(await stub.commit(update)).toEqual({ version: 1, applied: [], duplicate: true });
		});

		it("メモリから追い出されたあとでも、同じコミットだと分かる", async () => {
			const stub = page("duplicate-evicted");
			await stub.commit(commit);
			await evictDurableObject(stub);

			expect(await stub.commit(commit)).toMatchObject({ duplicate: true });
		});

		it("覚えておくコミットのIDは、新しいものから1万件まで", async () => {
			const stub = page("duplicate-prune");
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec(`
					INSERT INTO commits (id, version)
					WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
					SELECT 'old-' || i, 0 FROM n
				`);
			});

			await stub.commit(commit);

			await runInDurableObject(stub, (_instance, state) => {
				const count = state.storage.sql.exec("SELECT COUNT(*) AS count FROM commits").one();
				const oldest = state.storage.sql
					.exec("SELECT id FROM commits ORDER BY rowid LIMIT 1")
					.one();
				expect(count).toEqual({ count: 10000 });
				expect(oldest).toEqual({ id: "old-2" });
			});
		});
	});

	describe("台帳への知らせ(ADR-0024)", () => {
		const directory = exports.ProjectDO.getByName("test-project");

		it("効いたコミットのあとで、台帳にページの1行目とバージョンを知らせる", async () => {
			const info = await directory.open("知らせる前の名前");
			const stub = page(info.id);

			await commitTo(stub, [insertAfter(null, "a", "知らせたあとの名前")]);
			expect(await runDurableObjectAlarm(stub)).toBe(true);

			expect(await directory.open("知らせたあとの名前")).toEqual({
				id: info.id,
				title: "知らせたあとの名前",
				problem: null,
			});
		});

		it("何も効かなかったコミットでは、知らせない", async () => {
			const stub = page("index-no-op");

			await commitTo(stub, [{ type: "delete", id: id("missing") }]);

			expect(await runDurableObjectAlarm(stub)).toBe(false);
		});

		it("続けてコミットしても、知らせは最後の内容で1度だけ", async () => {
			const info = await directory.open("続けて書く");
			const stub = page(info.id);

			await commitTo(stub, [insertAfter(null, "a", "途")]);
			await commitTo(stub, [{ type: "update", id: id("a"), text: "途中" }]);
			await commitTo(stub, [{ type: "update", id: id("a"), text: "書き終えた名前" }]);

			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(await runDurableObjectAlarm(stub)).toBe(false);
			expect((await directory.open("書き終えた名前")).id).toBe(info.id);
			// 途中の名前は、台帳に載っていない(開くと、別の新しいページになる)。
			expect((await directory.open("途中")).id).not.toBe(info.id);
		});

		it("知らせの予約が消えていても、同じコミットの送り直しで予約し直す", async () => {
			// 保存したあとで予約に失敗すると、コミットは失敗として返り、端末は同じコミットを送り直す。
			const info = await directory.open("予約し直す");
			const stub = page(info.id);
			const commit = { id: nextCommitId(), changes: [insertAfter(null, "a", "予約し直した名前")] };
			await stub.commit(commit);
			await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());

			expect(await stub.commit(commit)).toMatchObject({ duplicate: true });

			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect((await directory.open("予約し直した名前")).id).toBe(info.id);
		});

		it("知らせ終えたあとは、送り直しが来ても予約しない", async () => {
			const stub = page("index-settled");
			const commit = { id: nextCommitId(), changes: [insertAfter(null, "a", "知らせ終えた")] };
			await stub.commit(commit);
			await runDurableObjectAlarm(stub);

			await stub.commit(commit);

			expect(await runDurableObjectAlarm(stub)).toBe(false);
		});

		it("知らせていない変更があることは、メモリから追い出されても覚えている", async () => {
			const info = await directory.open("追い出される");
			const stub = page(info.id);
			const commit = {
				id: nextCommitId(),
				changes: [insertAfter(null, "a", "追い出されたあとの名前")],
			};
			await stub.commit(commit);
			await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
			await evictDurableObject(stub);

			await stub.commit(commit);

			expect(await runDurableObjectAlarm(stub)).toBe(true);
		});

		it("行がなくなったページは、空の1行目として知らせる(名前は変わらない)", async () => {
			const info = await directory.open("空にする");
			const stub = page(info.id);
			await commitTo(stub, [insertAfter(null, "a", "空にする")]);
			await commitTo(stub, [{ type: "delete", id: id("a") }]);

			await runDurableObjectAlarm(stub);

			expect(await directory.open("空にする")).toEqual({ ...info, problem: "empty" });
		});
	});

	it("行はSQLiteに1行ずつ保存される", async () => {
		const stub = page("storage");
		await commitTo(stub, [insertAfter(null, "a", "A"), insertAfter("a", "b", "B")]);

		await runInDurableObject(stub, (_instance, state) => {
			const rows = state.storage.sql
				.exec("SELECT id, text FROM page_lines ORDER BY position")
				.toArray();
			expect(rows).toEqual([
				{ id: "a", text: "A" },
				{ id: "b", text: "B" },
			]);
		});
	});

	it("コミットでは変わった行だけを書き込む(他の行の並び順の値は変わらない)", async () => {
		const stub = page("diff-write");
		await commitTo(stub, [insertAfter(null, "a", "A"), insertAfter("a", "c", "C")]);
		const positions = () =>
			runInDurableObject(stub, (_instance, state) =>
				Object.fromEntries(
					state.storage.sql
						.exec<{ id: string; position: string }>("SELECT id, position FROM page_lines")
						.toArray()
						.map((row) => [row.id, row.position]),
				),
			);
		const before = await positions();

		await commitTo(stub, [insertAfter("a", "b", "B"), { type: "update", id: id("c"), text: "C2" }]);

		const after = await positions();
		expect(after).toMatchObject(before);
		expect((await stub.getPage()).lines).toEqual([line("a", "A"), line("b", "B"), line("c", "C2")]);
	});

	it("挿入・移動・削除を繰り返しても、保存した並び順は変更を順に適用した結果と一致する", async () => {
		const stub = page("many-operations");
		let model: readonly Line[] = [];
		// 再現できるように、決まった数列で操作を選ぶ。
		let seed = 12345;
		const next = (bound: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return bound === 0 ? 0 : seed % bound;
		};
		const pick = () => model[next(model.length)]?.id ?? null;

		for (let step = 0; step < 80; step += 1) {
			const target = pick();
			const kind = target === null ? 0 : next(5);
			const change: Change =
				target === null || kind <= 2
					? { type: "insert", line: line(`n${step}`, `${step}`), after: pick(), before: null }
					: kind === 3
						? { type: "move", id: target, after: pick(), before: pick() }
						: { type: "delete", id: target };

			await commitTo(stub, [change]);
			model = applyChanges(model, [change]).lines;
		}

		const saved = await stub.getPage();
		expect(saved.lines).toEqual(model);
		expect(model.length).toBeGreaterThan(10);
		await evictDurableObject(stub);
		expect((await stub.getPage()).lines).toEqual(model);
	});
});
