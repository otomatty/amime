import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, received } from "./received.ts";

/** 本文を受け取り終えたあとで、呼ばれた順を記録するアプリ。 */
function build(calls: string[] = []) {
	return new Hono().use(received).all("/", async (c) => {
		calls.push("handler");
		return c.json({ length: (await c.req.raw.arrayBuffer()).byteLength });
	});
}

/** あとから中身を送れる本文。 */
function pendingBody() {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const body = new ReadableStream<Uint8Array>({
		start(started) {
			controller = started;
		},
	});
	return {
		body,
		send: (bytes: number) => controller?.enqueue(new Uint8Array(bytes)),
		end: () => controller?.close(),
	};
}

const streamed = (body: ReadableStream<Uint8Array>) =>
	({ method: "POST", body, duplex: "half" }) as RequestInit;

describe("received(本文を、すべて受け取ってから先へ進める)", () => {
	it("本文のない要求は、そのまま先へ進める", async () => {
		const response = await build().request("/");

		expect(await response.json()).toEqual({ length: 0 });
	});

	it("本文は、そのまま読める", async () => {
		const response = await build().request("/", { method: "POST", body: "x".repeat(1000) });

		expect(await response.json()).toEqual({ length: 1000 });
	});

	it("本文を送り終えるまで、先へ進めない(権限を確かめるのは、本文を受け取ったあと)", async () => {
		const calls: string[] = [];
		const { body, send, end } = pendingBody();
		const pending = build(calls).request("/", streamed(body));
		send(10);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(calls).toEqual([]);
		send(5);
		end();

		expect(await (await pending).json()).toEqual({ length: 15 });
		expect(calls).toEqual(["handler"]);
	});

	it("上限ちょうどの本文は、通す", async () => {
		const body = new Uint8Array(MAX_BODY_BYTES);

		const response = await build().request("/", { method: "POST", body });

		expect(await response.json()).toEqual({ length: MAX_BODY_BYTES });
	});

	it("大きさを名乗っていて、上限を超える本文は、読まずに 413 で断る", async () => {
		const calls: string[] = [];
		const body = new Uint8Array(MAX_BODY_BYTES + 1);

		const response = await build(calls).request("/", { method: "POST", body });

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "body-too-large" });
		expect(calls).toEqual([]);
	});

	it("大きさを名乗らずに送られてきて、上限を超えた本文も、413 で断る", async () => {
		const calls: string[] = [];
		const { body, send } = pendingBody();
		const pending = build(calls).request("/", streamed(body));

		send(MAX_BODY_BYTES);
		send(1);

		const response = await pending;
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "body-too-large" });
		expect(calls).toEqual([]);
	});
});
