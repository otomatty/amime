import {
	type ClientId,
	type ClientMessage,
	type CommitResult,
	type CursorPosition,
	MAX_LINE_LENGTH,
	parseServerMessage,
	type ServerMessage,
	type TitleProblem,
} from "@amime/sync";

/** 接続が生きているかを確かめる間隔。 */
export const HEARTBEAT_MS = 30_000;
/** カーソルの位置を送る間隔の下限。続けて動かしているあいだは、この間隔で最後の位置だけを送る。 */
export const CURSOR_INTERVAL_MS = 100;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export type PageSocketHandlers = {
	/** 接続した直後に、サーバーのいまのバージョンが届いた。 */
	readonly onHello: (version: number) => void;
	/** 他の端末のコミットが届いた。 */
	readonly onCommit: (event: CommitResult) => void;
	/** 他の端末のカーソルが動いた。null は、その端末がカーソルを出していない。 */
	readonly onCursor?: (client: ClientId, cursor: CursorPosition | null) => void;
	/** 他の端末が接続を閉じた。 */
	readonly onLeave?: (client: ClientId) => void;
	/** つながった(true)、切れた(false)。切れているあいだは、他の端末の変更もカーソルも届かない。 */
	readonly onConnection?: (connected: boolean) => void;
	/** ページの名前を、サーバーが1行目に合わせて確かめた(ADR-0024)。 */
	readonly onPage?: (title: string, problem: TitleProblem | null) => void;
	/** ページが削除された(ADR-0026)。 */
	readonly onDeleted?: () => void;
};

/** ページの WebSocket の接続。 */
export type PageSocket = {
	/** 接続を閉じて、つなぎ直しをやめる。 */
	readonly close: () => void;
	/** 自分のカーソルの位置を、他の端末に知らせる。null は、カーソルを出していない。 */
	readonly sendCursor: (cursor: CursorPosition | null) => void;
};

type PageSocketOptions = {
	readonly url: string;
	readonly handlers: PageSocketHandlers;
	/** 接続の作り方。テストで差し替える。 */
	readonly createSocket?: (url: string) => WebSocket;
};

/**
 * ページの WebSocket に接続し、切れたらつなぎ直し続ける(ADR-0018)。
 *
 * 切れているあいだのコミットは受け取れない。つなぎ直すとサーバーがいまのバージョンを送ってくるので、
 * 受け取る側が、遅れていれば読み直す。
 */
export function connectPageSocket({
	url,
	handlers,
	createSocket = (target) => new WebSocket(target),
}: PageSocketOptions): PageSocket {
	let socket: WebSocket | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = FIRST_RETRY_MS;
	let awaitingPong = false;
	/** あいさつが届いて、つながっていると分かっているか。 */
	let connected = false;
	/** 最後に知らせた、接続の状態。まだ知らせていなければ null。同じ状態は、続けて知らせない。 */
	let reported: boolean | null = null;
	const report = (state: boolean) => {
		if (reported === state) return;
		reported = state;
		handlers.onConnection?.(state);
	};
	/** 最後に知らせるよう頼まれた、自分のカーソルの位置。まだ頼まれていなければ undefined。 */
	let cursor: CursorPosition | null | undefined;
	/** いまの接続で、最後に送ったカーソルの位置(JSON)。 */
	let sentCursor: string | null = null;
	let cursorTimer: ReturnType<typeof setTimeout> | null = null;

	/** いまのカーソルの位置を送る。つながっていないときと、送ってある位置と同じときは、送らない。 */
	const flushCursor = () => {
		if (!connected || socket === null || cursor === undefined) return;
		// 編集欄は、送れない長さの行も持てる。サーバーが受け付ける範囲に丸める(範囲の外を送ると、接続を閉じられる)。
		const message: ClientMessage = {
			type: "cursor",
			cursor: cursor && { ...cursor, column: Math.min(cursor.column, MAX_LINE_LENGTH) },
		};
		const data = JSON.stringify(message);
		if (data === sentCursor) return;
		socket.send(data);
		sentCursor = data;
		// 続けて動かしているあいだは、間隔をあけて、最後の位置だけを送る。
		cursorTimer = setTimeout(() => {
			cursorTimer = null;
			flushCursor();
		}, CURSOR_INTERVAL_MS);
	};

	/** いまの接続を手放す。 */
	const release = () => {
		if (heartbeat !== null) clearInterval(heartbeat);
		heartbeat = null;
		if (cursorTimer !== null) clearTimeout(cursorTimer);
		cursorTimer = null;
		sentCursor = null;
		const current = socket;
		socket = null;
		current?.close();
	};

	/** 接続が切れた。間隔を延ばしながらつなぎ直す。 */
	const lost = (current: WebSocket) => {
		if (socket !== current) return;
		release();
		connected = false;
		retryTimer = setTimeout(open, retryDelay);
		retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
		// つなぎ直しの予約を済ませてから知らせる。知らせの中で close が呼ばれても、予約が取り消される。
		// 1度もつながらないまま切れたときも知らせる(つながらない環境で、いつまでも「接続中」に見えないように)。
		report(false);
	};

	const receive = (message: ServerMessage) => {
		switch (message.type) {
			case "hello":
				retryDelay = FIRST_RETRY_MS;
				connected = true;
				report(true);
				handlers.onHello(message.version);
				// サーバーは、前の接続のカーソルの位置を覚えていない。いまの位置を送り直す。
				flushCursor();
				return;
			case "commit":
				handlers.onCommit(message);
				return;
			case "cursor":
				handlers.onCursor?.(message.client, message.cursor);
				return;
			case "leave":
				handlers.onLeave?.(message.client);
				return;
			case "page":
				handlers.onPage?.(message.title, message.problem);
				return;
			case "deleted":
				handlers.onDeleted?.();
				return;
		}
	};

	function open(): void {
		const current = createSocket(url);
		socket = current;
		awaitingPong = false;

		current.addEventListener("message", (event) => {
			if (socket !== current) return;
			if (event.data === "pong") {
				awaitingPong = false;
				return;
			}
			const message = parseServerMessage(event.data);
			if (message.ok) receive(message.value);
		});
		current.addEventListener("close", () => lost(current));

		// 通信が黙って途切れると、閉じたことが伝わらない場合がある。応答がなければ、切れたものとして扱う。
		heartbeat = setInterval(() => {
			if (current.readyState !== WebSocket.OPEN) return;
			if (awaitingPong) {
				lost(current);
				return;
			}
			awaitingPong = true;
			current.send("ping");
		}, HEARTBEAT_MS);
	}

	open();
	return {
		close() {
			if (retryTimer !== null) clearTimeout(retryTimer);
			connected = false;
			release();
		},
		sendCursor(next) {
			cursor = next;
			if (cursorTimer === null) flushCursor();
		},
	};
}
