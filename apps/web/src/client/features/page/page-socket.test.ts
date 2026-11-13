import { type LineId, MAX_LINE_LENGTH } from "@amime/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_INTERVAL_MS, connectPageSocket, HEARTBEAT_MS } from "./page-socket.ts";

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
	const handlers = {
		onHello: vi.fn(),
		onCommit: vi.fn(),
		onCursor: vi.fn(),
		onLeave: vi.fn(),
		onConnection: vi.fn(),
	};
	const { close, sendCursor } = connectPageSocket({
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
	/** 送ったメッセージのうち、カーソルの位置。 */
	const cursors = (socket = latest()) =>
		socket.sent.filter((data) => data !== "ping").map((data) => JSON.parse(data).cursor);
	return { sockets, handlers, close, sendCursor, latest, cursors };
}

const HELLO = '{"type":"hello","version":0}';
const at = (line: string, column: number) => ({ line: line as LineId, column });

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

	describe("他の人のカーソル(ADR-0023)", () => {
		it("他の端末のカーソルの位置と、接続を閉じた知らせを受け取る", () => {
			const { latest, handlers } = connect();

			latest().receive('{"type":"cursor","client":"bob","cursor":{"line":"a","column":2}}');
			latest().receive('{"type":"cursor","client":"bob","cursor":null}');
			latest().receive('{"type":"leave","client":"bob"}');

			expect(handlers.onCursor.mock.calls).toEqual([
				["bob", at("a", 2)],
				["bob", null],
			]);
			expect(handlers.onLeave).toHaveBeenCalledExactlyOnceWith("bob");
		});

		it("自分のカーソルの位置を送る", () => {
			const { latest, sendCursor, cursors } = connect();
			latest().receive(HELLO);

			sendCursor(at("a", 1));

			expect(cursors()).toEqual([at("a", 1)]);
		});

		it("続けて動かしたときは、間隔をあけて、最後の位置だけを送る", () => {
			const { latest, sendCursor, cursors } = connect();
			latest().receive(HELLO);

			sendCursor(at("a", 1));
			sendCursor(at("a", 2));
			sendCursor(at("a", 3));
			expect(cursors()).toEqual([at("a", 1)]);

			vi.advanceTimersByTime(CURSOR_INTERVAL_MS);
			expect(cursors()).toEqual([at("a", 1), at("a", 3)]);

			// 間隔があいたあとは、またすぐに送る。
			vi.advanceTimersByTime(CURSOR_INTERVAL_MS);
			sendCursor(null);
			expect(cursors()).toEqual([at("a", 1), at("a", 3), null]);
		});

		it("同じ位置は、続けて送らない", () => {
			const { latest, sendCursor, cursors } = connect();
			latest().receive(HELLO);

			sendCursor(at("a", 1));
			vi.advanceTimersByTime(CURSOR_INTERVAL_MS);
			sendCursor(at("a", 1));

			expect(cursors()).toEqual([at("a", 1)]);
		});

		it("つながる前に動かした位置は、つながったときに送る", () => {
			const { latest, sendCursor, cursors } = connect();

			sendCursor(at("a", 1));
			expect(cursors()).toEqual([]);
			latest().receive(HELLO);

			expect(cursors()).toEqual([at("a", 1)]);
		});

		it("つなぎ直したら、いまの位置を送り直す(サーバーは、前の接続の位置を覚えていない)", () => {
			const { sockets, latest, sendCursor, cursors } = connect();
			latest().receive(HELLO);
			sendCursor(at("a", 1));

			latest().close();
			sendCursor(at("a", 2));
			vi.advanceTimersByTime(1000);
			expect(sockets).toHaveLength(2);
			expect(cursors()).toEqual([]);
			latest().receive(HELLO);

			expect(cursors()).toEqual([at("a", 2)]);
		});

		it("カーソルを1度も知らせていなければ、つながっても何も送らない", () => {
			const { latest, cursors } = connect();

			latest().receive(HELLO);

			expect(cursors()).toEqual([]);
		});

		it("行の長さの上限より後ろの位置は、上限に丸めて送る(サーバーが受け付けない位置を送ると、接続を閉じられる)", () => {
			const { latest, sendCursor, cursors } = connect();
			latest().receive(HELLO);

			sendCursor(at("a", MAX_LINE_LENGTH + 5));

			expect(cursors()).toEqual([at("a", MAX_LINE_LENGTH)]);
		});

		it("閉じたあとは、送らない", () => {
			const { sockets, latest, sendCursor, close, cursors } = connect();
			latest().receive(HELLO);
			sendCursor(at("a", 1));
			sendCursor(at("a", 2));

			close();
			vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 2);
			sendCursor(at("a", 3));

			expect(cursors(sockets[0])).toEqual([at("a", 1)]);
		});
	});

	describe("接続の状態", () => {
		it("つながったとき(あいさつが届いたとき)と、切れたときに知らせる", () => {
			const { latest, handlers } = connect();
			expect(handlers.onConnection).not.toHaveBeenCalled();

			latest().receive(HELLO);
			expect(handlers.onConnection.mock.calls).toEqual([[true]]);

			latest().close();
			expect(handlers.onConnection.mock.calls).toEqual([[true], [false]]);

			vi.advanceTimersByTime(1000);
			latest().receive(HELLO);
			expect(handlers.onConnection.mock.calls).toEqual([[true], [false], [true]]);
		});

		it("1度もつながらないまま切れたときも、切れたと知らせる。知らせを繰り返さない", () => {
			const { latest, handlers } = connect();

			latest().close();
			expect(handlers.onConnection.mock.calls).toEqual([[false]]);

			vi.advanceTimersByTime(1000);
			latest().close();
			expect(handlers.onConnection.mock.calls).toEqual([[false]]);

			vi.advanceTimersByTime(2000);
			latest().receive(HELLO);
			expect(handlers.onConnection.mock.calls).toEqual([[false], [true]]);
		});

		it("切れた知らせの中で接続を閉じたら、つなぎ直さない", () => {
			const { sockets, latest, handlers, close } = connect();
			latest().receive(HELLO);
			handlers.onConnection.mockImplementation((connected: boolean) => {
				if (!connected) close();
			});

			latest().close();
			vi.advanceTimersByTime(60_000);

			expect(sockets).toHaveLength(1);
		});
	});
});
