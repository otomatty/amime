import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ready } from "./migrate.ts";

const tables = async () =>
	(
		await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
			name: string;
		}>()
	).results.map((row) => row.name);

describe("ready(データベースのスキーマを最新にする)", () => {
	it("表を作り、当てた変更の番号を記録する。何度呼んでも、同じ結果になる", async () => {
		await ready(env.DB);
		await ready(env.DB);

		expect(await tables()).toEqual(expect.arrayContaining(["migrations", "users", "sessions"]));
		const { results } = await env.DB.prepare(
			"SELECT version FROM migrations ORDER BY version",
		).all<{
			version: number;
		}>();
		expect(results[0]).toEqual({ version: 1 });
		expect(new Set(results.map((row) => row.version)).size).toBe(results.length);
	});

	it("別の実行環境から当て直しても(確かめ直しても)、壊れない", async () => {
		await ready(env.DB);
		await env.DB.prepare(
			"INSERT INTO users (id, provider, subject, email, name, created) VALUES ('m1', 'dev', ?, 'm@x', 'm', 0)",
		)
			.bind(`migrate-${crypto.randomUUID()}`)
			.run();

		// 同じデータベースを、確かめたことを覚えていない別の入口から使う。
		const again = {
			exec: (query: string) => env.DB.exec(query),
			prepare: (query: string) => env.DB.prepare(query),
			batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
		} as D1Database;
		await ready(again);

		const row = await env.DB.prepare("SELECT name FROM users WHERE id = 'm1'").first();
		expect(row).toEqual({ name: "m" });
		await env.DB.prepare("DELETE FROM users WHERE id = 'm1'").run();
	});
});
