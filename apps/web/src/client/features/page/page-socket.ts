import { type CommitResult, parseServerMessage } from "@amime/sync";

/** 接続が生きているかを確かめる間隔。 */
export const HEARTBEAT_MS = 30_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export type PageSocketHandlers = {
	/** 接続した直後に、サーバーのいまのバージョンが届いた。 */
	readonly onHello: (version: number) => void;
	/** 他の端末のコミットが届いた。 */
	readonly onCommit: (event: CommitResult) => void;
};

type PageSocketOptions = {
	readonly url: string;
	readonly handlers: PageSocketHandlers;
	/** 接続の作り方。テストで差し替える。 */
	readonly createSocket?: (url: string) => WebSocket;
};

/**
 * ページの WebSocket に接続し、切れたらつなぎ直し続ける(ADR-0018)。
 * 返した関数を呼ぶと、接続を閉じてつなぎ直しをやめる。
 *
 * 切れているあいだのコミットは受け取れない。つなぎ直すとサーバーがいまのバージョンを送ってくるので、
 * 受け取る側が、遅れていれば読み直す。
 */
export function connectPageSocket({
	url,
	handlers,
	createSocket = (target) => new WebSocket(target),
}: PageSocketOptions): () => void {
	let socket: WebSocket | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = FIRST_RETRY_MS;
	let awaitingPong = false;

	/** いまの接続を手放す。 */
	const release = () => {
		if (heartbeat !== null) clearInterval(heartbeat);
		heartbeat = null;
		const current = socket;
		socket = null;
		current?.close();
	};

	/** 接続が切れた。間隔を延ばしながらつなぎ直す。 */
	const lost = (current: WebSocket) => {
		if (socket !== current) return;
		release();
		retryTimer = setTimeout(open, retryDelay);
		retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
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
			if (!message.ok) return;
			if (message.value.type === "hello") {
				retryDelay = FIRST_RETRY_MS;
				handlers.onHello(message.value.version);
			} else {
				handlers.onCommit(message.value);
			}
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
	return () => {
		if (retryTimer !== null) clearTimeout(retryTimer);
		release();
	};
}
