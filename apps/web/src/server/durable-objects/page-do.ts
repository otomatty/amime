import { DurableObject } from "cloudflare:workers";
import {
	applyChanges,
	type Change,
	type ClientId,
	type Commit,
	type CommitId,
	type CommitResult,
	type CursorPosition,
	type Line,
	type LineId,
	type PageSnapshot,
	parseClientMessage,
	parseCursorPosition,
	type ServerMessage,
} from "@amime/sync";
import { generateKeyBetween } from "fractional-indexing";

type LineRow = { id: string; text: string };

/**
 * 覚えておくコミットのIDの数(ページごと)。
 * これより前のコミットを送り直されると、もう1度適用してしまう。送り直しは、ふつう数秒から数分のうちに来る。
 * 端末内に残した変更の復元(最長30日後。ADR-0020)でも、そのあいだのコミットがこの数を超えなければ見分けられる。
 */
const REMEMBERED_COMMITS = 10_000;

/** WebSocket の終了コード: 方針に反するメッセージを受け取った。 */
const WS_POLICY_VIOLATION = 1008;

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
			CREATE TABLE IF NOT EXISTS commits (
				id TEXT PRIMARY KEY,
				version INTEGER NOT NULL
			);
		`);
		// 接続が生きているかをクライアントが確かめるための応答。休止中でも、起こされずに返る。
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	/**
	 * WebSocket の接続を受け付ける(ADR-0018)。接続は休止に対応した方式で持つので、
	 * やりとりがないあいだは、接続を保ったままメモリから降ろされる。
	 * 要求の検査(切り替えの要求であること、端末の識別子)は、呼び出す Worker の側で済ませてある。
	 */
	override fetch(request: Request): Response {
		const client = new URL(request.url).searchParams.get("client") ?? "";
		const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
		// いまいる他の端末のカーソルを、先に集めておく(自分の接続を数えないため)。
		const others = this.ctx.getWebSockets().flatMap((socket): ServerMessage[] => {
			const owner = this.#clientOf(socket);
			const cursor = this.#cursorOf(socket);
			return owner === client || cursor === null ? [] : [{ type: "cursor", client: owner, cursor }];
		});
		// 端末の識別子をタグにする。その端末のコミットを、本人の接続には配信しないため。
		this.ctx.acceptWebSocket(serverSocket, [client]);
		this.#send(serverSocket, { type: "hello", version: this.#version() });
		for (const message of others) this.#send(serverSocket, message);
		return new Response(null, { status: 101, webSocket: clientSocket });
	}

	/**
	 * クライアントからのメッセージ。自動で応答する ping のほかは、カーソルの位置だけを受け付ける(ADR-0023)。
	 * カーソルの位置は保存しない。接続に添えて覚えておき(休止しても残る)、他の端末に配る。
	 * 決めていないメッセージを送る接続は閉じる。
	 */
	override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		const parsed = parseClientMessage(message);
		if (!parsed.ok) {
			socket.close(WS_POLICY_VIOLATION, "unexpected message");
			return;
		}
		const { cursor } = parsed.value;
		socket.serializeAttachment(cursor);
		this.#broadcast({ type: "cursor", client: this.#clientOf(socket), cursor }, socket);
	}

	/** 接続が閉じた。その端末のカーソルを消すように、他の端末に知らせる。 */
	override webSocketClose(socket: WebSocket): void {
		this.#left(socket);
	}

	override webSocketError(socket: WebSocket): void {
		this.#left(socket);
	}

	#left(socket: WebSocket): void {
		const client = this.#clientOf(socket);
		// 同じ端末が、もうつなぎ直している。その端末は、まだいる。
		const remains = this.ctx
			.getWebSockets(client)
			.some((other) => other !== socket && other.readyState === WebSocket.OPEN);
		if (!remains) this.#broadcast({ type: "leave", client }, socket);
	}

	/** 接続している端末の識別子(接続を受け付けたときに付けたタグ)。 */
	#clientOf(socket: WebSocket): ClientId {
		// タグは、接続を受け付ける前に Worker が検査した識別子。
		return (this.ctx.getTags(socket)[0] ?? "") as ClientId;
	}

	/** その接続の端末が最後に知らせてきた、カーソルの位置。 */
	#cursorOf(socket: WebSocket): CursorPosition | null {
		const cursor = parseCursorPosition(socket.deserializeAttachment());
		return cursor.ok ? cursor.value : null;
	}

	/** sender と同じ端末の接続を除く、すべての接続に送る。 */
	#broadcast(message: ServerMessage, sender: WebSocket): void {
		const skipped = new Set(this.ctx.getWebSockets(this.#clientOf(sender)));
		for (const socket of this.ctx.getWebSockets()) {
			if (!skipped.has(socket)) this.#send(socket, message);
		}
	}

	getPage(): PageSnapshot {
		return { version: this.#version(), lines: this.#lines() };
	}

	/**
	 * コミットを適用する。対象の行がなくなっている変更は、その変更だけを捨てる(ADR-0016)。
	 * 実際に効いた変更と、適用後のバージョンを返す。何も効かなければ、バージョンは進まない。
	 * 効いた変更は、接続している他の端末に配信する。client は、送った端末の識別子。
	 */
	commit(commit: Commit, client?: ClientId): CommitResult {
		// 同じコミットを送り直してきた(前の応答が届かなかった)。もう適用してあるので、何もしない(ADR-0021)。
		if (this.#seen(commit.id)) return { version: this.#version(), applied: [], duplicate: true };

		const { applied } = applyChanges(this.#lines(), commit.changes);
		const version = this.#version() + (applied.length > 0 ? 1 : 0);
		this.ctx.storage.transactionSync(() => {
			// 効いた変更は、位置が実際の前後の行に書き直してある。順に書けば、保存した内容も同じ結果になる。
			for (const change of applied) this.#write(change);
			this.ctx.storage.sql.exec(
				"INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
				version,
			);
			// 何も効かなかったコミットも覚えておく。送り直しで、あとから効いてしまわないようにする。
			this.#remember(commit.id, version);
		});
		if (applied.length === 0) return { version, applied };

		// 保存してから配信する。送った本人は応答で結果を受け取るので、本人の接続には送らない。
		const skipped = new Set(client === undefined ? [] : this.ctx.getWebSockets(client));
		for (const socket of this.ctx.getWebSockets()) {
			if (!skipped.has(socket)) this.#send(socket, { type: "commit", version, applied });
		}
		return { version, applied };
	}

	#send(socket: WebSocket, message: ServerMessage): void {
		try {
			socket.send(JSON.stringify(message));
		} catch {
			// 閉じかけの接続には送れない。受け取れなかった端末は、つなぎ直したときに読み直す。
		}
	}

	/** このIDのコミットを、以前に受け付けたか。 */
	#seen(id: CommitId): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM commits WHERE id = ?", id).toArray().length > 0;
	}

	/** 受け付けたコミットのIDを覚える。覚えておくのは、新しいものから REMEMBERED_COMMITS 件まで。 */
	#remember(id: CommitId, version: number): void {
		const { sql } = this.ctx.storage;
		sql.exec("INSERT INTO commits (id, version) VALUES (?, ?)", id, version);
		sql.exec(
			"DELETE FROM commits WHERE rowid <= (SELECT MAX(rowid) FROM commits) - ?",
			REMEMBERED_COMMITS,
		);
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
