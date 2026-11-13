import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges } from "./changes.ts";
import { MAX_CHANGES, MAX_COMMIT_TEXT_LENGTH } from "./schema.ts";
import {
	acknowledge,
	createSession,
	edit,
	failed,
	hasUnsaved,
	pendingChanges,
	receive,
	resync,
	type Session,
	send,
	splitChanges,
	withPending,
} from "./session.ts";
import type { Change, CommitId, CommitResult, Line, LineId } from "./types.ts";

const id = (value: string): LineId => value as LineId;
const line = (lineId: string, text: string = lineId.toUpperCase()): Line => ({
	id: id(lineId),
	text,
});

let commitSerial = 0;
/** 呼ぶたびに違う、コミットのID。 */
const nextCommitId = (): CommitId => {
	commitSerial += 1;
	return `commit-${commitSerial}` as CommitId;
};

/** 送信を始める。送るものがなければ null。 */
function trySend(session: Session) {
	const sending = send(session, nextCommitId());
	return sending && { ...sending, changes: sending.commit.changes };
}

/** 送信できる変更があるはずの場面で、送信を始める。 */
function mustSend(session: Session) {
	const sending = trySend(session);
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
		expect(trySend(session)).toBeNull();
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

		expect(mustSend(session).changes).toEqual([
			{ type: "update", id: id("a"), text: "A2", base: "A" },
		]);
	});

	it("送信中は、次の送信を始めない(1度に1つのコミットだけを送る)", () => {
		const { session } = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));

		expect(trySend(edit(session, [line("a", "A3"), line("b")]))).toBeNull();
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
		expect(next && mustSend(next).changes).toEqual([
			{ type: "update", id: id("b"), text: "B2", base: "B" },
		]);
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

	it("サーバーに断られたら、送信中の状態をやめる。内容が変わらなければ、次の送信で同じ変更をもう一度送る", () => {
		const sending = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));

		const next = failed(sending.session);

		expect(hasUnsaved(next)).toBe(true);
		expect(mustSend(next).changes).toEqual(sending.changes);
	});

	it("送信中でないときの読み直し(受け取りそこねた分に追いつく)でも、まだ送っていない編集は残る", () => {
		const session = edit(createSession(snapshot), [line("a"), line("b"), line("mine")]);

		const next = resync(session, { version: 5, lines: [line("x"), line("a"), line("b")] });

		expect(next.local).toEqual([line("x"), line("a"), line("b"), line("mine")]);
		expect(hasUnsaved(next)).toBe(true);
	});

	it("応答が届かなかった送信は、送信中のまま残る。同じコミットを、同じIDで送り直せる", () => {
		const sending = mustSend(edit(createSession(snapshot), [line("a", "A2"), line("b")]));
		const typedMore = edit(sending.session, [line("a", "A2"), line("b", "B2")]);

		// 何もしなければ、送信中のコミットはそのまま。新しい送信は始まらない。
		expect(typedMore.inflight).toBe(sending.commit);
		expect(trySend(typedMore)).toBeNull();
		expect(hasUnsaved(typedMore)).toBe(true);
	});
});

describe("pendingChanges / withPending(未送信の変更の取り出しと、載せ直し)", () => {
	const snapshot = { version: 3, lines: [line("a"), line("b")] };

	it("未送信の変更がなければ、空になる", () => {
		expect(pendingChanges(createSession(snapshot))).toEqual({ inflight: null, changes: [] });
	});

	it("まだ送っていない編集を、確定した文書からの変更として取り出す", () => {
		const session = edit(createSession(snapshot), [line("a", "A2"), line("b"), line("n")]);

		expect(pendingChanges(session)).toEqual({
			inflight: null,
			changes: [
				{ type: "update", id: id("a"), text: "A2", base: "A" },
				{ type: "insert", line: line("n"), after: id("b"), before: null },
			],
		});
	});

	it("送信中のコミットは、IDと一緒に別に取り出す。残りは、そのコミットが入ったあとの文書からの変更", () => {
		const sending = mustSend(
			edit(createSession(snapshot), [...snapshot.lines, line("n", "書きかけ")]),
		);
		const typedMore = edit(sending.session, [...snapshot.lines, line("n", "書きかけの続き")]);

		expect(pendingChanges(typedMore)).toEqual({
			inflight: sending.commit,
			changes: [{ type: "update", id: id("n"), text: "書きかけの続き", base: "書きかけ" }],
		});
	});

	it("取り出した変更を、あとで読み込んだページに載せ直せる。そのあいだの他の人の変更は残る", () => {
		const session = edit(createSession(snapshot), [line("a", "A2"), line("b"), line("n")]);
		const later = [line("x"), line("a"), line("b")];

		expect(withPending(later, [pendingChanges(session).changes])).toEqual([
			line("x"),
			line("a", "A2"),
			line("b"),
			line("n"),
		]);
	});

	it("載せるものがなければ、同じ文書を返す", () => {
		expect(withPending(snapshot.lines, [[], []])).toBe(snapshot.lines);
	});

	it("複数の記録は、渡した順に載せる", () => {
		const first = [{ type: "update", id: id("a"), text: "1" }] as const;
		const second = [{ type: "update", id: id("a"), text: "2" }] as const;

		expect(withPending(snapshot.lines, [first, second])).toEqual([line("a", "2"), line("b")]);
	});
});

describe("receive(他の人のコミットの受け取り)", () => {
	const snapshot = { version: 3, lines: [line("a"), line("b")] };
	const fromOther = (version: number, ...applied: Change[]) => ({ version, applied });
	const insertX: Change = { type: "insert", line: line("x"), after: null, before: null };

	it("次のバージョンのコミットを、確定した文書と画面の文書の両方に反映する", () => {
		const next = receive(createSession(snapshot), fromOther(4, insertX));

		expect(next).toMatchObject({ version: 4, inflight: null });
		expect(next?.confirmed).toEqual([line("x"), line("a"), line("b")]);
		expect(next?.local).toEqual([line("x"), line("a"), line("b")]);
		expect(next && hasUnsaved(next)).toBe(false);
	});

	it("まだ送っていない自分の編集は、受け取ったあとも残る", () => {
		const session = edit(createSession(snapshot), [line("a"), line("b", "B2")]);

		const next = receive(session, fromOther(4, insertX));

		expect(next?.local).toEqual([line("x"), line("a"), line("b", "B2")]);
		expect(next && mustSend(next).changes).toEqual([
			{ type: "update", id: id("b"), text: "B2", base: "B" },
		]);
	});

	it("送信中に受け取ったら、送信中のままにして、あとから届く応答をそのまま反映できる", () => {
		const sending = mustSend(edit(createSession(snapshot), [line("a"), line("b", "B2")]));

		// 他の人のコミット(バージョン4)が先にサーバーに入り、自分のコミットはバージョン5になった。
		const received = receive(sending.session, fromOther(4, insertX));
		expect(received?.inflight).toBe(sending.commit);
		expect(received?.local).toEqual([line("x"), line("a"), line("b", "B2")]);

		const next = received && acknowledge(received, { version: 5, applied: sending.changes });
		expect(next).toMatchObject({ version: 5, inflight: null });
		expect(next?.confirmed).toEqual([line("x"), line("a"), line("b", "B2")]);
		expect(next && hasUnsaved(next)).toBe(false);
	});

	it("他の人が消した行への自分の編集は、画面からも消える(削除が勝つ)", () => {
		const session = edit(createSession(snapshot), [line("a"), line("b", "B2")]);

		const next = receive(session, fromOther(4, { type: "delete", id: id("b") }));

		expect(next?.local).toEqual([line("a")]);
		expect(next && hasUnsaved(next)).toBe(false);
	});

	it("既に反映してあるバージョンのコミットは無視する", () => {
		const session = createSession(snapshot);

		expect(receive(session, fromOther(3, insertX))).toBe(session);
		expect(receive(session, fromOther(2, insertX))).toBe(session);
	});

	it("あいだのバージョンが抜けていたら、反映せず、読み直しを求める", () => {
		expect(receive(createSession(snapshot), fromOther(5, insertX))).toBeNull();
	});
});

describe("splitChanges(変更の列を、コミットに収まる大きさに分ける)", () => {
	const deletes = (count: number): Change[] =>
		Array.from({ length: count }, (_, index) => ({ type: "delete", id: id(`n${index}`) }));

	it("変更がなければ、空", () => {
		expect(splitChanges([])).toEqual([]);
	});

	it("1つのコミットに収まるなら、分けない", () => {
		const changes = deletes(3);

		expect(splitChanges(changes)).toEqual([changes]);
	});

	it("変更の数が上限を超えるなら、順序を保って分ける", () => {
		const changes = deletes(MAX_CHANGES * 2 + 1);

		const parts = splitChanges(changes);

		expect(parts.map((part) => part.length)).toEqual([MAX_CHANGES, MAX_CHANGES, 1]);
		expect(parts.flat()).toEqual(changes);
	});
});

describe("1つのコミットに収まらない変更", () => {
	/** 送信と受け付けを、送るものがなくなるまで繰り返す。送ったコミットを返す。 */
	function saveAll(start: Session, server: ReturnType<typeof createServer>) {
		const commits: (readonly Change[])[] = [];
		let session = start;
		for (let sending = trySend(session); sending !== null; sending = trySend(session)) {
			commits.push(sending.changes);
			const next = acknowledge(sending.session, server.commit(sending.changes));
			if (next === null) throw new Error("unexpected gap");
			session = next;
		}
		return { commits, session };
	}

	it("変更の数が上限を超えるときは、上限までを送り、残りは次の送信で送る", () => {
		const server = createServer();
		const local = Array.from({ length: MAX_CHANGES + 500 }, (_, index) => line(`n${index}`, "x"));

		const { commits, session } = saveAll(edit(createSession(server.snapshot()), local), server);

		expect(commits.map((changes) => changes.length)).toEqual([MAX_CHANGES, 500]);
		expect(server.snapshot().lines).toEqual(local);
		expect(hasUnsaved(session)).toBe(false);
	});

	it("本文の合計が上限を超えるときも、分けて送る", () => {
		const server = createServer();
		const text = "あ".repeat(MAX_COMMIT_TEXT_LENGTH / 4);
		const local = Array.from({ length: 10 }, (_, index) => line(`n${index}`, text));

		const { commits } = saveAll(edit(createSession(server.snapshot()), local), server);

		expect(commits.map((changes) => changes.length)).toEqual([4, 4, 2]);
		expect(server.snapshot().lines).toEqual(local);
	});

	it("本文を置き換える変更は、元にした本文も一緒に送るので、その長さも数える", () => {
		const text = "あ".repeat(MAX_COMMIT_TEXT_LENGTH / 8);
		const before = Array.from({ length: 10 }, (_, index) => line(`n${index}`, text));
		const server = createServer(before);
		const local = before.map((current) => ({ ...current, text: `${current.text}!` }));

		const { commits } = saveAll(edit(createSession(server.snapshot()), local), server);

		expect(commits.map((changes) => changes.length)).toEqual([3, 3, 3, 1]);
		expect(server.snapshot().lines).toEqual(local);
	});

	it("1つの変更だけで本文の上限を超えるときも、その1つは送る(送れるかどうかはサーバーが決める)", () => {
		const local = [line("a", "x".repeat(MAX_COMMIT_TEXT_LENGTH + 1)), line("b")];

		const sending = mustSend(edit(createSession({ version: 0, lines: [] }), local));

		expect(sending.changes).toHaveLength(1);
	});
});

describe("複数の端末が同じページを編集したとき", () => {
	const CLIENTS = [0, 1, 2] as const;
	type Step =
		| {
				readonly type: "edit";
				readonly client: number;
				readonly seed: number;
				readonly text: string;
		  }
		/** send: 送信する / respond: 送信への応答が届く / deliver: 他の人のコミットが1つ届く */
		| { readonly type: "send" | "respond" | "deliver"; readonly client: number };

	const client = fc.constantFrom(...CLIENTS);
	const step: fc.Arbitrary<Step> = fc.oneof(
		fc.record({
			type: fc.constant("edit" as const),
			client,
			seed: fc.nat(),
			text: fc.constantFrom("x", "y", "z"),
		}),
		fc.record({ type: fc.constantFrom("send", "respond", "deliver"), client }),
	);

	/** seed から決まる編集(行の追加・書き換え・削除・移動)を、画面の文書に行う。 */
	function editLocal(local: readonly Line[], seed: number, text: string, newId: LineId) {
		const index = local.length === 0 ? 0 : seed % local.length;
		const target = local[index];
		const action = target === undefined ? 0 : seed % 6;
		if (target === undefined || action === 0) return local.toSpliced(index, 0, line(newId, text));
		if (action === 1) return local.with(index, { id: target.id, text });
		if (action === 2) return local.toSpliced(index, 1);
		if (action === 3) return [...local.toSpliced(index, 1), target];
		// 行の中に文字を足す、行の中の文字を消す(同じ行を同時に書き換えると、文字単位で統合される)。
		const at = (seed >> 3) % (target.text.length + 1);
		const typed =
			action === 4
				? target.text.slice(0, at) + text + target.text.slice(at)
				: target.text.slice(0, at) + target.text.slice(at + 1);
		return local.with(index, { id: target.id, text: typed });
	}

	/** seed から決まる行の、seed から決まる位置に、文字を足す。 */
	function typeLocal(local: readonly Line[], seed: number, text: string) {
		const index = seed % local.length;
		const target = local[index];
		if (target === undefined) throw new Error("no line to type in");
		const at = (seed >> 3) % (target.text.length + 1);
		const typed = target.text.slice(0, at) + text + target.text.slice(at);
		return local.with(index, { id: target.id, text: typed });
	}

	/**
	 * サーバーと3つの端末を模した世界。
	 * 送信への応答と、他の人のコミットの配信は、別々の経路で届く。どちらが先に届くかは決まっていない。
	 */
	function createWorld() {
		const server = createServer([line("a"), line("b"), line("c")]);
		const sessions = CLIENTS.map(() => createSession(server.snapshot()));
		const responses: (CommitResult | null)[] = CLIENTS.map(() => null);
		const inboxes: CommitResult[][] = CLIENTS.map(() => []);
		/** 配信に抜けがあったが、送信中だったので読み直しを後回しにしている端末。 */
		const behind = new Set<number>();
		const sessionOf = (who: number): Session => {
			const session = sessions[who];
			if (session === undefined) throw new Error("no such client");
			return session;
		};

		const world = {
			server,
			sessionOf,
			edit(who: number, change: (local: readonly Line[]) => readonly Line[]) {
				const session = sessionOf(who);
				sessions[who] = edit(session, change(session.local));
			},
			send(who: number) {
				const sending = trySend(sessionOf(who));
				if (sending === null) return;
				sessions[who] = sending.session;
				const result = server.commit(sending.changes);
				responses[who] = result;
				if (result.applied.length === 0) return;
				// 効いたコミットは、送った本人以外の全員に配信される。
				for (const other of CLIENTS) if (other !== who) inboxes[other]?.push(result);
			},
			respond(who: number) {
				const result = responses[who];
				if (result === null || result === undefined) return;
				responses[who] = null;
				const session = sessionOf(who);
				const next = acknowledge(session, result) ?? resync(session, server.snapshot());
				sessions[who] = behind.delete(who) ? resync(next, server.snapshot()) : next;
			},
			deliver(who: number) {
				const event = inboxes[who]?.shift();
				if (event === undefined) return;
				const session = sessionOf(who);
				const next = receive(session, event);
				// 抜けがあったら読み直す。送信中なら、応答が届いてから読み直す。
				if (next !== null) sessions[who] = next;
				else if (session.inflight === null) sessions[who] = resync(session, server.snapshot());
				else behind.add(who);
			},
			/** 届いていないものをすべて届け、残った変更を保存し終える。 */
			settle(who: number) {
				for (let round = 0; round < 4; round += 1) {
					world.respond(who);
					while ((inboxes[who]?.length ?? 0) > 0) world.deliver(who);
					world.send(who);
				}
				world.respond(who);
			},
		};
		return world;
	}

	it("応答と配信がどんな順で届いても、全員が保存し終えれば、全員の画面がサーバーの文書と同じになる", () => {
		fc.assert(
			fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
				const world = createWorld();

				steps.forEach((current, serial) => {
					if (current.type === "edit") {
						const newId = id(`c${current.client}-${serial}`);
						world.edit(current.client, (local) =>
							editLocal(local, current.seed, current.text, newId),
						);
					} else {
						world[current.type](current.client);
					}
				});

				for (const who of CLIENTS) {
					world.settle(who);
					expect(hasUnsaved(world.sessionOf(who))).toBe(false);
				}
				// 最後に保存した人のコミットを、全員が受け取る。
				for (const who of CLIENTS) {
					world.settle(who);
					const latest = resync(world.sessionOf(who), world.server.snapshot());
					expect(latest.local).toEqual(world.server.snapshot().lines);
					expect(world.sessionOf(who).local).toEqual(world.server.snapshot().lines);
					expect(hasUnsaved(latest)).toBe(false);
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("全員が同じ行に同時に文字を足しても、足した文字はどれも失われず、2重にもならない(ADR-0022)", () => {
		const typing: fc.Arbitrary<Step> = fc.oneof(
			fc.record({
				type: fc.constant("edit" as const),
				client,
				seed: fc.nat(),
				text: fc.constant(""),
			}),
			fc.record({ type: fc.constantFrom("send", "respond", "deliver"), client }),
		);
		fc.assert(
			fc.property(fc.array(typing, { maxLength: 40 }), (steps) => {
				const world = createWorld();
				/** 足した文字。1文字ずつ、すべて違う文字にする。 */
				const typed: string[] = [];

				steps.forEach((current, serial) => {
					if (current.type === "edit") {
						const character = String.fromCodePoint(0x4e00 + serial);
						typed.push(character);
						world.edit(current.client, (local) => typeLocal(local, current.seed, character));
					} else {
						world[current.type](current.client);
					}
				});
				for (const who of CLIENTS) world.settle(who);
				for (const who of CLIENTS) world.settle(who);

				const text = world.server
					.snapshot()
					.lines.map((current) => current.text)
					.join("");
				expect([...text].toSorted()).toEqual([..."ABC", ...typed].toSorted());
				for (const who of CLIENTS) {
					expect(world.sessionOf(who).local).toEqual(world.server.snapshot().lines);
				}
			}),
			{ numRuns: 500 },
		);
	});
});
