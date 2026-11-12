import { DurableObject } from "cloudflare:workers";
import { applyChanges, type Change, type Line, type LineId } from "@amime/sync";

type LineRow = { id: string; text: string };

type PageSnapshot = {
	/** コミットが成功するたびに1ずつ増える。 */
	readonly version: number;
	readonly lines: readonly Line[];
};

type CommitResult = {
	readonly version: number;
	readonly applied: readonly Change[];
};

/**
 * 1ページ = 1インスタンス。ページへのコミットをここで直列化する。
 * 正となるデータは常にSQLiteにあり、メモリには状態を持たない。
 */
export class PageDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS lines (
				position INTEGER PRIMARY KEY,
				id TEXT NOT NULL UNIQUE,
				text TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value INTEGER NOT NULL
			);
		`);
	}

	getPage(): PageSnapshot {
		return { version: this.#version(), lines: this.#lines() };
	}

	/**
	 * 変更をまとめて適用する。対象の行がなくなっている変更は、その変更だけを捨てる(ADR-0016)。
	 * 実際に効いた変更と、適用後のバージョンを返す。何も効かなければ、バージョンは進まない。
	 */
	commit(changes: readonly Change[]): CommitResult {
		const { lines, applied } = applyChanges(this.#lines(), changes);
		if (applied.length === 0) return { version: this.#version(), applied };

		const version = this.#version() + 1;
		const { sql } = this.ctx.storage;
		this.ctx.storage.transactionSync(() => {
			// P0では全行を書き直す。行数に比例するため、P2で差分書き込みに置き換える(ADR-0006)。
			sql.exec("DELETE FROM lines");
			lines.forEach((line, position) => {
				sql.exec(
					"INSERT INTO lines (position, id, text) VALUES (?, ?, ?)",
					position,
					line.id,
					line.text,
				);
			});
			sql.exec(
				"INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
				version,
			);
		});
		return { version, applied };
	}

	#lines(): Line[] {
		return this.ctx.storage.sql
			.exec<LineRow>("SELECT id, text FROM lines ORDER BY position")
			.toArray()
			.map((row) => ({ id: row.id as LineId, text: row.text }));
	}

	#version(): number {
		const rows = this.ctx.storage.sql
			.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'version'")
			.toArray();
		return rows[0]?.value ?? 0;
	}
}
