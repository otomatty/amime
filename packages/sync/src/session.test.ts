import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges } from "./changes.ts";
import {
	acknowledge,
	createSession,
	edit,
	failed,
	hasUnsaved,
	resync,
	type Session,
	send,
} from "./session.ts";
import type { Change, Line, LineId } from "./types.ts";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string = lineId.toUpperCase()): Line => ({
	id: id(lineId),
	text,
});

/** 送信できる変更があるはずの場面で、送信を始める。 */
function mustSend(session: Session) {
	const sending = send(session);
	if (sending === null) throw new Error("nothing to send");
	return sending;
}

/** サーバーの代わり。コミットを受け取った順に適用する。 */
function createServer(lines: readonly Line[] = []) {
	let state = { version: 0, lines };
	return {
		snapshot: () => state,
		commit(changes: readonly Change[]) {
			const result = applyChanges(state.lines, changes);
			if (result.applied.length > 0) state = { version: state.version + 1, lines: result.lines };
			return { version: state.version, applied: result.applied };
		},
	};
}

describe("セッション(1つの端末から見たページの状態)", () => {
	const snapshot = { version: 3, lines: [line("a"), line("b")] };

	it("読み込んだ直後は、画面の文書が確定した文書と同じで、未保存の変更はない", () => {
		const session = createSession(snapshot);

		expect(session.local).toBe(snapshot.lines);
		expect(hasUnsaved(session)).toBe(false);
		expect(send(session)).toBeNull();
	});

	it("編集すると、未保存の変更がある状態になる", () => {
		const session = edit(createSession(snapshot), [line("a", "A2"), line("b")]);

		expect(hasUnsaved(session)).toBe(true);
	});

	it("同じ文書を渡された編集では、何も変わらない", () => {
		const session = createSession(snapshot);

		expect(edit(session, session.local)).toBe(session);
	});

	it("送信では、確定した文書との差分を送る", () => {
		const session = edit(createSession(snapshot), [line("a", "A2"), line("b")]);

		expect(mustSend(session).changes).toEqual([{ type: "update", id: id("a"), text: "A2" }]);
	});

	it("送信中は、次の送信を始めない(1度に1つのコミットだけを送る)", () => {
		const { session } = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));

		expect(send(edit(session, [line("a", "A3"), line("b")]))).toBeNull();
	});

	it("サーバーが受け付けると、確定した文書が進み、未保存の変更がなくなる", () => {
		const local = [line("a", "A2"), line("b")];
		const { session, changes } = mustSend(edit(createSession(snapshot), local));

		const next = acknowledge(session, { version: 4, applied: changes });

		expect(next).toMatchObject({ version: 4, confirmed: local, inflight: null });
		// 画面の文書は変わっていないので、同じ配列のまま(編集欄を描き直さない)。
		expect(next?.local).toBe(local);
		expect(next && hasUnsaved(next)).toBe(false);
	});

	it("送信中に書き足した分は、受け付けられたあとも画面に残り、次の送信で送られる", () => {
		const sending = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));
		const typedMore = edit(sending.session, [line("a", "A2"), line("b", "B2")]);

		const next = acknowledge(typedMore, { version: 4, applied: sending.changes });

		expect(next?.local).toEqual([line("a", "A2"), line("b", "B2")]);
		expect(next && mustSend(next).changes).toEqual([{ type: "update", id: id("b"), text: "B2" }]);
	});

	it("何も効かなかったコミットでは、バージョンは進まない", () => {
		const { session } = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));

		expect(acknowledge(session, { version: 3, applied: [] })).toMatchObject({
			version: 3,
			confirmed: snapshot.lines,
			inflight: null,
		});
	});

	it("バージョンが飛んでいたら(他の人の変更が先に入っていたら)、受け付けを反映せず、読み直しを求める", () => {
		const { session, changes } = mustSend(
			edit(createSession(snapshot), [line("a", "A2"), line("b")]),
		);

		expect(acknowledge(session, { version: 6, applied: changes })).toBeNull();
		expect(acknowledge(session, { version: 4, applied: [] })).toBeNull();
	});

	it("読み直すと、他の人の変更を取り込み、まだ送っていない自分の編集を載せ直す", () => {
		const sending = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));
		const typedMore = edit(sending.session, [line("a", "A2"), line("b"), line("mine")]);
		// サーバーには、他の人の行 x と、自分が送った a の変更が入っている。
		const latest = { version: 6, lines: [line("x"), line("a", "A2"), line("b")] };

		const next = resync(typedMore, latest);

		expect(next).toMatchObject({ version: 6, confirmed: latest.lines, inflight: null });
		expect(next.local).toEqual([line("x"), line("a", "A2"), line("b"), line("mine")]);
		expect(mustSend(next).changes).toEqual([
			{ type: "insert", line: line("mine"), after: id("b"), before: null },
		]);
	});

	it("読み直したとき、サーバーが捨てた自分の変更は、画面からも消える", () => {
		// 自分は b を書き換えて送ったが、他の人が先に b を消していた。
		const { session } = mustSend(edit(createSession(snapshot), [line("a"), line("b", "B2")]));

		const next = resync(session, { version: 4, lines: [line("a")] });

		expect(next.local).toEqual([line("a")]);
		expect(hasUnsaved(next)).toBe(false);
	});

	it("送信に失敗したら、送信中の状態をやめる。次の送信で、同じ変更をもう一度送る", () => {
		const sending = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));

		const next = failed(sending.session);

		expect(hasUnsaved(next)).toBe(true);
		expect(mustSend(next).changes).toEqual(sending.changes);
	});

	it("応答が届かなかっただけでサーバーには入っていた場合、送り直しても二重にならず、読み直しで追いつく", () => {
		const server = createServer(snapshot.lines);
		const local = [line("a"), line("b"), line("new")];
		const first = mustSend(edit(createSession({ version: 0, lines: snapshot.lines }), local));
		server.commit(first.changes); // 応答は届かなかった

		const retry = mustSend(failed(first.session));
		const result = server.commit(retry.changes);

		expect(result.applied).toEqual([]);
		expect(acknowledge(retry.session, result)).toBeNull();
		const next = resync(retry.session, server.snapshot());
		expect(next.local).toEqual(local);
		expect(hasUnsaved(next)).toBe(false);
	});
});

describe("複数の端末が同じページを編集したとき", () => {
	type Step =
		| {
				readonly type: "edit";
				readonly client: number;
				readonly seed: number;
				readonly text: string;
		  }
		| { readonly type: "save"; readonly client: number };

	const step: fc.Arbitrary<Step> = fc.oneof(
		fc.record({
			type: fc.constant("edit" as const),
			client: fc.integer({ min: 0, max: 2 }),
			seed: fc.nat(),
			text: fc.constantFrom("x", "y", "z"),
		}),
		fc.record({ type: fc.constant("save" as const), client: fc.integer({ min: 0, max: 2 }) }),
	);

	/** seed から決まる編集(行の追加・書き換え・削除・移動)を、画面の文書に行う。 */
	function editLocal(local: readonly Line[], seed: number, text: string, newId: LineId) {
		const index = local.length === 0 ? 0 : seed % local.length;
		const target = local[index];
		const action = target === undefined ? 0 : seed % 4;
		if (target === undefined || action === 0) return local.toSpliced(index, 0, line(newId, text));
		if (action === 1) return local.with(index, { id: target.id, text });
		if (action === 2) return local.toSpliced(index, 1);
		return [...local.toSpliced(index, 1), target];
	}

	it("全員が保存し終えて読み直せば、全員の画面がサーバーの文書と同じになる", () => {
		fc.assert(
			fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
				const server = createServer([line("a"), line("b"), line("c")]);
				const sessions = [0, 1, 2].map(() => createSession(server.snapshot()));
				const sessionOf = (client: number): Session => {
					const session = sessions[client];
					if (session === undefined) throw new Error("no such client");
					return session;
				};
				const save = (client: number) => {
					const sending = send(sessionOf(client));
					if (sending === null) return;
					const result = server.commit(sending.changes);
					sessions[client] =
						acknowledge(sending.session, result) ?? resync(sending.session, server.snapshot());
				};

				steps.forEach((current, serial) => {
					if (current.type === "save") {
						save(current.client);
						return;
					}
					const session = sessionOf(current.client);
					const newId = id(`c${current.client}-${serial}`);
					const local = editLocal(session.local, current.seed, current.text, newId);
					sessions[current.client] = edit(session, local);
				});

				// 残った変更を保存する。保存は、読み直しを挟んでも数回で必ず終わる。
				for (const client of [0, 1, 2]) {
					for (let attempt = 0; attempt < 3; attempt += 1) save(client);
					expect(hasUnsaved(sessionOf(client))).toBe(false);
				}
				for (const client of [0, 1, 2]) {
					const latest = resync(sessionOf(client), server.snapshot());
					expect(latest.local).toEqual(server.snapshot().lines);
					expect(hasUnsaved(latest)).toBe(false);
				}
			}),
			{ numRuns: 300 },
		);
	});
});
