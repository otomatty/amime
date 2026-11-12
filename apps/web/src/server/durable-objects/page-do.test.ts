import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { applyChanges, type Change, type Line, type LineId } from "@amime/sync";
import { describe, expect, it } from "vitest";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });
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

		const first = await stub.commit(inserts);
		const second = await stub.commit([update]);

		expect(first).toEqual({ version: 1, applied: inserts });
		expect(second).toEqual({ version: 2, applied: [update] });
		expect(await stub.getPage()).toEqual({
			version: 2,
			lines: [line("a", "タイトル"), line("b", "本文2")],
		});
	});

	it("行の並び順を保つ", async () => {
		const stub = page("order");

		await stub.commit([insertAfter(null, "c", "3"), insertAfter("c", "a", "1")]);
		await stub.commit([insertAfter("c", "b", "2")]);
		await stub.commit([{ type: "move", id: id("c"), after: id("a"), before: null }]);

		expect((await stub.getPage()).lines.map((l) => l.id)).toEqual(["b", "a", "c"]);
	});

	it("対象の行がなくなっている変更だけを捨て、残りを適用する。効いた変更を返す", async () => {
		const stub = page("lenient");
		await stub.commit([insertAfter(null, "a", "A")]);
		const update: Change = { type: "update", id: id("a"), text: "A2" };

		const result = await stub.commit([{ type: "delete", id: id("missing") }, update]);

		expect(result).toEqual({ version: 2, applied: [update] });
		expect(await stub.getPage()).toEqual({ version: 2, lines: [line("a", "A2")] });
	});

	it("何も効かなかったコミットでは、バージョンを進めない", async () => {
		const stub = page("no-op");
		await stub.commit([insertAfter(null, "a", "A")]);

		const result = await stub.commit([{ type: "delete", id: id("missing") }]);

		expect(result).toEqual({ version: 1, applied: [] });
		expect((await stub.getPage()).version).toBe(1);
	});

	it("ページごとに状態が独立している", async () => {
		await page("isolated-1").commit([insertAfter(null, "a", "A")]);

		expect(await page("isolated-2").getPage()).toEqual({ version: 0, lines: [] });
	});

	it("メモリから追い出されても、保存した内容から復元できる", async () => {
		const stub = page("durable");
		await stub.commit([insertAfter(null, "a", "A")]);

		await evictDurableObject(stub);

		expect(await stub.getPage()).toEqual({ version: 1, lines: [line("a", "A")] });
	});

	it("行はSQLiteに1行ずつ保存される", async () => {
		const stub = page("storage");
		await stub.commit([insertAfter(null, "a", "A"), insertAfter("a", "b", "B")]);

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
		await stub.commit([insertAfter(null, "a", "A"), insertAfter("a", "c", "C")]);
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

		await stub.commit([insertAfter("a", "b", "B"), { type: "update", id: id("c"), text: "C2" }]);

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

			await stub.commit([change]);
			model = applyChanges(model, [change]).lines;
		}

		const saved = await stub.getPage();
		expect(saved.lines).toEqual(model);
		expect(model.length).toBeGreaterThan(10);
		await evictDurableObject(stub);
		expect((await stub.getPage()).lines).toEqual(model);
	});
});
