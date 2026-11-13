import { DurableObject, exports } from "cloudflare:workers";
import { renameLinks, summarizePage } from "@amime/parser";
import { toTitleLc } from "@amime/shared";
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
	MAX_LINE_LENGTH,
	type PageId,
	type PageInfo,
	type PageSnapshot,
	parseClientMessage,
	parseCursorPosition,
	parsePageTitle,
	type ServerMessage,
} from "@amime/sync";
import { generateKeyBetween } from "fractional-indexing";

type LineRow = { id: string; text: string };

/** meta の表に持つ数値。deleted は、削除されたページなら 1。 */
type MetaKey = "version" | "updated" | "dirty" | "deleted";

/**
 * 覚えておくコミットのIDの数(ページごと)。
 * これより前のコミットを送り直されると、もう1度適用してしまう。送り直しは、ふつう数秒から数分のうちに来る。
 * 端末内に残した変更の復元(最長30日後。ADR-0020)でも、そのあいだのコミットがこの数を超えなければ見分けられる。
 */
const REMEMBERED_COMMITS = 10_000;

/**
 * ページが変更されてから、台帳に知らせるまでの待ち時間(ADR-0024)。
 * 続けて変更されているあいだは待ち、落ち着いてから知らせる(書いている途中の1行目を、名前にしないため)。
 */
const INDEX_DELAY_MS = 2000;
/** 変更が続いていても、最初の変更からこの時間がたったら知らせる。 */
const INDEX_MAX_WAIT_MS = 10_000;

/** WebSocket の終了コード: 正常に閉じた。 */
const WS_NORMAL = 1000;
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
			CREATE TABLE IF NOT EXISTS notes (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
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
		if (this.#deleted()) {
			// 削除されたページ。接続は受け付けて、削除されたことだけを伝えて閉じる
			// (接続を断ると、画面には失敗の理由が伝わらず、つなぎ直し続ける)。
			serverSocket.accept();
			serverSocket.send(JSON.stringify({ type: "deleted" } satisfies ServerMessage));
			serverSocket.close(WS_NORMAL, "page deleted");
			return new Response(null, { status: 101, webSocket: clientSocket });
		}
		// いまいる他の端末のカーソルを、先に集めておく(自分の接続を数えないため)。
		// 同じ端末の接続がいくつかあっても(つなぎ直しの途中)、端末ごとに1つにまとめる。
		const others = new Map<ClientId, CursorPosition>();
		for (const socket of this.ctx.getWebSockets()) {
			const owner = this.#clientOf(socket);
			const cursor = this.#cursorOf(socket);
			if (owner !== client && cursor !== null) others.set(owner, cursor);
		}
		// 端末の識別子をタグにする。その端末のコミットを、本人の接続には配信しないため。
		this.ctx.acceptWebSocket(serverSocket, [client]);
		this.#send(serverSocket, { type: "hello", version: this.#version() });
		// 台帳に確かめてあるページの名前も送る。切れているあいだに名前が変わっていても、追いつける。
		const named = this.#named();
		if (named !== null) this.#send(serverSocket, { type: "page", ...named });
		for (const [owner, cursor] of others) {
			this.#send(serverSocket, { type: "cursor", client: owner, cursor });
		}
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
		const client = this.#clientOf(socket);
		// 同じ端末の接続がいくつかあっても(つなぎ直しの途中)、どの接続にも同じ位置を覚えさせる。
		// 前の接続に古い位置が残っていると、あとから接続した端末に、それを伝えてしまう。
		for (const own of this.ctx.getWebSockets(client)) own.serializeAttachment(cursor);
		this.#broadcast({ type: "cursor", client, cursor }, socket);
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

	/** ページの内容。削除されたページなら "deleted"。 */
	getPage(): PageSnapshot | "deleted" {
		if (this.#deleted()) return "deleted";
		return { version: this.#version(), lines: this.#lines() };
	}

	/**
	 * ページを削除する(ADR-0026)。本文を消し、削除されたことを覚えておく。元には戻せない。
	 * このあとのコミットは受け付けない。開いている端末には、削除されたことを知らせる。
	 */
	async destroy(): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM page_lines; DELETE FROM commits; DELETE FROM notes;");
			this.#setMeta("deleted", 1);
			this.#setMeta("dirty", 0);
		});
		for (const socket of this.ctx.getWebSockets()) {
			this.#send(socket, { type: "deleted" });
			socket.close(WS_NORMAL, "page deleted");
		}
		await this.ctx.storage.deleteAlarm();
	}

	#deleted(): boolean {
		return this.#meta("deleted") !== 0;
	}

	/**
	 * コミットを適用する。対象の行がなくなっている変更は、その変更だけを捨てる(ADR-0016)。
	 * 実際に効いた変更と、適用後のバージョンを返す。何も効かなければ、バージョンは進まない。
	 * 効いた変更は、接続している他の端末に配信する。client は、送った端末の識別子。
	 */
	async commit(commit: Commit, client?: ClientId): Promise<CommitResult | "deleted"> {
		if (this.#deleted()) return "deleted";
		// 同じコミットを送り直してきた(前の応答が届かなかった)。もう適用してあるので、何もしない(ADR-0021)。
		if (this.#seen(commit.id)) {
			// 前回、保存したあとで台帳への知らせの予約に失敗していたら、ここで予約し直す。
			await this.#scheduleIndexing();
			return { version: this.#version(), applied: [], duplicate: true };
		}

		return this.#apply(commit.changes, commit.id, client);
	}

	/**
	 * 名前が from から to に変わったページへのリンクを、書き換える(ADR-0028)。台帳が呼ぶ。
	 * 書き換えは、ふつうのコミットと同じように保存し、開いている端末に配信する。
	 * 何度呼んでも、結果は同じ(書き換えるリンクが残っていなければ、何もしない)。
	 * 前の名前へのリンクが、このページに残っていなければ true を返す
	 * (新しい名前がリンクとして書けないときなどは、残る)。
	 */
	async rewriteLinks(from: string, to: string): Promise<boolean> {
		if (this.#deleted()) return true;
		const lines = this.#lines();
		const texts = lines.map((line) => line.text);
		const changes: Change[] = [];
		for (const { index, text } of renameLinks(texts, from, to)) {
			const line = lines[index];
			// 書き換えると長さの上限を超える行は、そのままにする(リンクは、前の名前を指したまま残る)。
			if (line === undefined || text.length > MAX_LINE_LENGTH) continue;
			texts[index] = text;
			changes.push({ type: "update", id: line.id, text });
		}
		if (changes.length > 0) await this.#apply(changes);
		const fromLc = toTitleLc(from);
		return !summarizePage(texts).links.some((title) => toTitleLc(title) === fromLc);
	}

	/**
	 * 変更を適用して保存し、接続している端末に配信する。
	 * id は、端末が送ってきたコミットのID。client は、送った端末の識別子。
	 */
	async #apply(
		changes: readonly Change[],
		id?: CommitId,
		client?: ClientId,
	): Promise<CommitResult> {
		const { applied } = applyChanges(this.#lines(), changes);
		const version = this.#version() + (applied.length > 0 ? 1 : 0);
		this.ctx.storage.transactionSync(() => {
			// 効いた変更は、位置が実際の前後の行に書き直してある。順に書けば、保存した内容も同じ結果になる。
			for (const change of applied) this.#write(change);
			this.#setMeta("version", version);
			// 何も効かなかったコミットも覚えておく。送り直しで、あとから効いてしまわないようにする。
			if (id !== undefined) this.#remember(id, version);
			if (applied.length > 0) {
				const now = Date.now();
				this.#setMeta("updated", now);
				// 台帳に知らせていない変更がある印。最初の変更の時刻を覚えておく(知らせ終えたら 0 に戻す)。
				if (this.#meta("dirty") === 0) this.#setMeta("dirty", now);
			}
		});
		if (applied.length === 0) return { version, applied };

		// 保存してから配信する。送った本人は応答で結果を受け取るので、本人の接続には送らない。
		const skipped = new Set(client === undefined ? [] : this.ctx.getWebSockets(client));
		for (const socket of this.ctx.getWebSockets()) {
			if (!skipped.has(socket)) this.#send(socket, { type: "commit", version, applied });
		}
		// 台帳への知らせの予約は、配信のあとで行う。予約に失敗しても、保存したコミットは他の端末に届いている
		// (送り直しは重複として扱うので、配信し直さない)。
		await this.#scheduleIndexing();
		return { version, applied };
	}

	/**
	 * 台帳への知らせを予約する。変更が続いているあいだは先に延ばす(上限つき)。
	 * 知らせは、編集の応答を待たせないように、アラームで行う。失敗しても、アラームがやり直す。
	 */
	async #scheduleIndexing(): Promise<void> {
		const dirtySince = this.#meta("dirty");
		if (dirtySince === 0) return;
		const at = Math.min(Date.now() + INDEX_DELAY_MS, dirtySince + INDEX_MAX_WAIT_MS);
		await this.ctx.storage.setAlarm(at);
	}

	/**
	 * 台帳(ProjectDO)に、ページのいまの状態を知らせる(ADR-0024)。
	 * 台帳は、ページの名前を1行目に合わせる。結果を、接続している端末に知らせる(URLや案内を合わせるため)。
	 */
	override async alarm(): Promise<void> {
		// この Durable Object の名前は「プロジェクト/ページのID」。
		const [project, page] = (this.ctx.id.name ?? "").split("/");
		if (project === undefined || page === undefined || this.#deleted()) return;
		const version = this.#version();
		const lines = this.#lines().map((line) => line.text);
		const info = await exports.ProjectDO.getByName(project).index(page as PageId, {
			title: lines[0] ?? "",
			version,
			updated: this.#meta("updated"),
			summary: summarizePage(lines),
		});
		// 知らせているあいだに削除されていたら、何も残さない。
		if (this.#deleted()) return;
		// 知らせているあいだに変更が入っていなければ、知らせ終えたことにする。
		// 入っていたら、その変更が次の知らせを予約している。
		if (this.#version() === version) this.#setMeta("dirty", 0);

		const named = { title: info.title, problem: info.problem };
		this.ctx.storage.sql.exec(
			"INSERT INTO notes (key, value) VALUES ('named', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			JSON.stringify(named),
		);
		for (const socket of this.ctx.getWebSockets()) this.#send(socket, { type: "page", ...named });
	}

	/** 台帳に確かめてある、ページの名前と、名前を1行目に合わせられない理由。まだ確かめていなければ null。 */
	#named(): Pick<PageInfo, "title" | "problem"> | null {
		const rows = this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM notes WHERE key = 'named'")
			.toArray();
		const stored = rows[0]?.value;
		if (stored === undefined) return null;
		// 自分で保存した値。
		const parsed = parsePageTitle(JSON.parse(stored));
		return parsed.ok ? parsed.value : null;
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
		return this.#meta("version");
	}

	#meta(key: MetaKey): number {
		const rows = this.ctx.storage.sql
			.exec<{ value: number }>("SELECT value FROM meta WHERE key = ?", key)
			.toArray();
		return rows[0]?.value ?? 0;
	}

	#setMeta(key: MetaKey, value: number): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}
}
