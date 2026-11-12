import { DurableObject } from "cloudflare:workers";
import {
	applyChanges,
	type Change,
	type CommitResult,
	type Line,
	type LineId,
	type PageSnapshot,
} from "@amime/sync";
import { generateKeyBetween } from "fractional-indexing";

type LineRow = { id: string; text: string };

/**
 * 1ページ = 1インスタンス。ページへのコミットをここで直列化する。
 * 正となるデータは常にSQLiteにあり、メモリには状態を持たない。
 *
 * 行の並び順は、行ごとの「順序キー」(position)で持つ(ADR-0017)。
 * 2つの行のあいだに行を入れるとき、あいだに入るキーを作れるので、他の行を書き換えずに済む。
 *
 * P0 で使っていた `lines` テーブルからの移行はしない。当時はページを書き込む経路がテストだけで、
 * どの環境にも保存されたページがない(ADR-0017)。今後テーブルの形を変えるときは、移行を書く。
 */
export class PageDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS page_lines (
				id TEXT PRIMARY KEY,
				position TEXT NOT NULL UNIQUE,
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
		const { applied } = applyChanges(this.#lines(), changes);
		if (applied.length === 0) return { version: this.#version(), applied };

		const version = this.#version() + 1;
		this.ctx.storage.transactionSync(() => {
			// 効いた変更は、位置が実際の前後の行に書き直してある。順に書けば、保存した内容も同じ結果になる。
			for (const change of applied) this.#write(change);
			this.ctx.storage.sql.exec(
				"INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
				version,
			);
		});
		return { version, applied };
	}

	/** 変更を1つ、保存した内容に書き込む。書き換えるのは、その変更の対象の行だけ。 */
	#write(change: Change): void {
		const { sql } = this.ctx.storage;
		switch (change.type) {
			case "insert":
				sql.exec(
					"INSERT INTO page_lines (id, position, text) VALUES (?, ?, ?)",
					change.line.id,
					this.#positionBetween(change.after, change.before),
					change.line.text,
				);
				return;
			case "update":
				sql.exec("UPDATE page_lines SET text = ? WHERE id = ?", change.text, change.id);
				return;
			case "delete":
				sql.exec("DELETE FROM page_lines WHERE id = ?", change.id);
				return;
			case "move":
				sql.exec(
					"UPDATE page_lines SET position = ? WHERE id = ?",
					this.#positionBetween(change.after, change.before),
					change.id,
				);
				return;
		}
	}

	/** 2つの行のあいだに入る順序キーを作る。null は、文書の先頭(after)または末尾(before)を表す。 */
	#positionBetween(after: LineId | null, before: LineId | null): string {
		return generateKeyBetween(this.#positionOf(after), this.#positionOf(before));
	}

	#positionOf(id: LineId | null): string | null {
		if (id === null) return null;
		const rows = this.ctx.storage.sql
			.exec<{ position: string }>("SELECT position FROM page_lines WHERE id = ?", id)
			.toArray();
		return rows[0]?.position ?? null;
	}

	#lines(): Line[] {
		return (
			this.ctx.storage.sql
				.exec<LineRow>("SELECT id, text FROM page_lines ORDER BY position")
				.toArray()
				// 保存してあるIDは、書き込むときに検査済み。
				.map((row) => ({ id: row.id as LineId, text: row.text }))
		);
	}

	#version(): number {
		const rows = this.ctx.storage.sql
			.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'version'")
			.toArray();
		return rows[0]?.value ?? 0;
	}
}
