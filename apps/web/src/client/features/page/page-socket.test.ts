import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectPageSocket, HEARTBEAT_MS } from "./page-socket.ts";

/** WebSocket の代わり。テストから、開く・受け取る・閉じるを起こせる。 */
class FakeSocket extends EventTarget {
	readyState: number = WebSocket.OPEN;
	readonly sent: string[] = [];
	readonly url: string;

	constructor(url: string) {
		super();
		this.url = url;
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		if (this.readyState === WebSocket.CLOSED) return;
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	receive(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

function connect() {
	const sockets: FakeSocket[] = [];
	const handlers = { onHello: vi.fn(), onCommit: vi.fn() };
	const close = connectPageSocket({
		url: "ws://amime.test/socket",
		handlers,
		createSocket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	});
	const latest = () => {
		const socket = sockets.at(-1);
		if (!socket) throw new Error("no socket");
		return socket;
	};
	return { sockets, handlers, close, latest };
}

describe("connectPageSocket", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("接続して、あいさつと他の人のコミットを受け取る", () => {
		const { latest, handlers } = connect();
		const commit = { type: "commit", version: 4, applied: [{ type: "delete", id: "a" }] };

		latest().receive('{"type":"hello","version":3}');
		latest().receive(JSON.stringify(commit));

		expect(latest().url).toBe("ws://amime.test/socket");
		expect(handlers.onHello).toHaveBeenCalledWith(3);
		expect(handlers.onCommit).toHaveBeenCalledWith(commit);
	});

	it("形の違うメッセージは無視する", () => {
		const { latest, handlers } = connect();

		latest().receive("???");
		latest().receive('{"type":"commit"}');

		expect(handlers.onCommit).not.toHaveBeenCalled();
	});

	it("切れたら、間隔を延ばしながらつなぎ直す。つながったら、間隔を元に戻す", () => {
		const { sockets, latest } = connect();

		latest().close();
		vi.advanceTimersByTime(999);
		expect(sockets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(2);

		// つながらないまま、また切れた。次は2秒待つ。
		latest().close();
		vi.advanceTimersByTime(1999);
		expect(sockets).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(3);

		latest().receive('{"type":"hello","version":0}');
		latest().close();
		vi.advanceTimersByTime(1000);
		expect(sockets).toHaveLength(4);
	});

	it("定期的に ping を送り、pong が返ってくるあいだは接続を保つ", () => {
		const { sockets, latest } = connect();

		vi.advanceTimersByTime(HEARTBEAT_MS);
		expect(latest().sent).toEqual(["ping"]);
		latest().receive("pong");
		vi.advanceTimersByTime(HEARTBEAT_MS);

		expect(latest().sent).toEqual(["ping", "ping"]);
		expect(sockets).toHaveLength(1);
	});

	it("pong が返ってこなければ、切れたものとして、つなぎ直す", () => {
		const { sockets } = connect();

		vi.advanceTimersByTime(HEARTBEAT_MS * 2);
		expect(sockets[0]?.readyState).toBe(WebSocket.CLOSED);
		vi.advanceTimersByTime(1000);

		expect(sockets).toHaveLength(2);
	});

	it("まだ開いていない接続には ping を送らない", () => {
		const { latest } = connect();
		latest().readyState = WebSocket.CONNECTING;

		vi.advanceTimersByTime(HEARTBEAT_MS * 3);

		expect(latest().sent).toEqual([]);
		expect(latest().readyState).toBe(WebSocket.CONNECTING);
	});

	it("閉じたあとは、つなぎ直さず、メッセージも渡さない", () => {
		const { sockets, close, handlers } = connect();
		const socket = sockets[0];

		close();
		socket?.receive('{"type":"hello","version":3}');
		vi.advanceTimersByTime(HEARTBEAT_MS * 10);

		expect(socket?.readyState).toBe(WebSocket.CLOSED);
		expect(sockets).toHaveLength(1);
		expect(handlers.onHello).not.toHaveBeenCalled();
	});
});
