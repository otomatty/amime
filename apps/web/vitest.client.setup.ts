import { beforeEach } from "vitest";

/**
 * jsdom が実装していないブラウザのAPIを補う。
 * テストで呼び出しを確かめたいときは vi.spyOn で差し替える。
 */
Element.prototype.scrollIntoView = () => {};

/**
 * jsdom の WebSocket は、実際に接続を試みる。テストでは、何もしない代用品に差し替える。
 * 接続のふるまいを確かめるテストは、自分で代用品を用意する。
 */
class InertWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly readyState = InertWebSocket.CONNECTING;
	send(): void {}
	close(): void {}
}
Object.defineProperty(globalThis, "WebSocket", { value: InertWebSocket, writable: true });

/**
 * ページのAPIは、URLの最初の部分のプロジェクトを宛先にする(ADR-0033)。
 * テストは、「team」というプロジェクトのトップを開いているところから始める。
 */
beforeEach(() => {
	window.history.replaceState(null, "", "/team/");
});
