import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { Change, Line, LineId } from "@amime/sync";
import { describe, expect, it } from "vitest";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string): Line => ({ id: id(lineId), text });
const insertAtEnd = (lineId: string, text: string): Change => ({
	type: "insert",
	before: null,
	line: line(lineId, text),
});

/** テストごとに別のページ(=別の Durable Object)を使い、状態を共有しない。 */
const page = (name: string) => exports.PageDO.getByName(`test-project/${name}`);

describe("PageDO", () => {
	it("新しいページは行を持たず、バージョンは0", async () => {
		expect(await page("empty").getPage()).toEqual({ version: 0, lines: [] });
	});

	it("コミットすると変更が適用され、バージョンが1つ進む", async () => {
		const stub = page("commit");

		const first = await stub.commit([insertAtEnd("a", "タイトル"), insertAtEnd("b", "本文")]);
		const second = await stub.commit([{ type: "update", id: id("b"), text: "本文2" }]);

		expect(first).toEqual({ ok: true, value: { version: 1 } });
		expect(second).toEqual({ ok: true, value: { version: 2 } });
		expect(await stub.getPage()).toEqual({
			version: 2,
			lines: [line("a", "タイトル"), line("b", "本文2")],
		});
	});

	it("行の並び順を保つ", async () => {
		const stub = page("order");

		await stub.commit([insertAtEnd("c", "3"), insertAtEnd("a", "1")]);
		await stub.commit([{ type: "insert", before: id("a"), line: line("b", "2") }]);

		expect((await stub.getPage()).lines.map((l) => l.id)).toEqual(["c", "b", "a"]);
	});

	it("適用できないコミットは全体を拒否し、状態を変えない", async () => {
		const stub = page("reject");
		await stub.commit([insertAtEnd("a", "A")]);

		const result = await stub.commit([
			{ type: "delete", id: id("a") },
			{ type: "delete", id: id("missing") },
		]);

		expect(result).toEqual({ ok: false, error: { kind: "line-not-found", id: "missing" } });
		expect(await stub.getPage()).toEqual({ version: 1, lines: [line("a", "A")] });
	});

	it("ページごとに状態が独立している", async () => {
		await page("isolated-1").commit([insertAtEnd("a", "A")]);

		expect(await page("isolated-2").getPage()).toEqual({ version: 0, lines: [] });
	});

	it("メモリから追い出されても、保存した内容から復元できる", async () => {
		const stub = page("durable");
		await stub.commit([insertAtEnd("a", "A")]);

		await evictDurableObject(stub);

		expect(await stub.getPage()).toEqual({ version: 1, lines: [line("a", "A")] });
	});

	it("行はSQLiteに1行ずつ保存される", async () => {
		const stub = page("storage");
		await stub.commit([insertAtEnd("a", "A"), insertAtEnd("b", "B")]);

		await runInDurableObject(stub, (_instance, state) => {
			const rows = state.storage.sql.exec("SELECT id, text FROM lines ORDER BY position").toArray();
			expect(rows).toEqual([
				{ id: "a", text: "A" },
				{ id: "b", text: "B" },
			]);
		});
	});
});
