import { createMiddleware } from "hono/factory";

/** 要求の本文の大きさの上限(バイト)。いちばん大きい本文は、ページのコミット。 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const TOO_LARGE = { error: "body-too-large" };

/** 本文を、上限まで読む。上限を超えたら null。 */
async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

/**
 * 本文を、すべて受け取ってから、先へ進める。ログインの状態や権限を確かめるより、前に置く(ADR-0034)。
 *
 * 権限を確かめたあとで本文を待つと、本文を送り終えないまま要求を開いておいて、権限がなくなったあとで送り終える、
 * ということができる。先に受け取ってしまえば、権限を確かめてから書き込むまでのあいだに、相手が待たせる場所がない。
 * 受け取る大きさには、上限を付ける(だれからの要求か、まだ分からないうちに読むので)。
 */
export const received = createMiddleware(async (c, next) => {
	const body = c.req.raw.body;
	if (body === null) return next();
	// 名乗っている大きさが上限を超えていたら、読まずに断る。
	if (Number(c.req.header("content-length")) > MAX_BODY_BYTES) return c.json(TOO_LARGE, 413);
	const bytes = await readAll(body);
	if (bytes === null) return c.json(TOO_LARGE, 413);
	c.req.raw = new Request(c.req.raw, { body: bytes });
	return next();
});
