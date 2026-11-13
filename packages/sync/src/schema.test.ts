import { describe, expect, it } from "vitest";
import {
	MAX_CHANGES,
	MAX_LINE_LENGTH,
	parseClientId,
	parseClientMessage,
	parseCommitRequest,
	parseCommitResult,
	parseCursorPosition,
	parsePageId,
	parsePageInfo,
	parsePendingRecord,
	parseServerMessage,
	parseSnapshot,
} from "./schema.ts";

const insert = { type: "insert", line: { id: "c1-0", text: "題" }, after: null, before: "c1-1" };
const update = { type: "update", id: "c1-0", text: "題2" };
const remove = { type: "delete", id: "c1-0" };
const move = { type: "move", id: "c1-0", after: "c1-1", before: null };

const parseChanges = (input: unknown) => {
	const parsed = parseCommitRequest({ id: "c1", changes: input });
	return parsed.ok ? { ok: true, value: parsed.value.changes } : parsed;
};

describe("parseCommitRequest", () => {
	it("コミットのIDと変更を受け付ける。送った端末の識別子は、なくてもよい", () => {
		expect(parseCommitRequest({ id: "c1", changes: [remove], client: "tab-1" })).toEqual({
			ok: true,
			value: { id: "c1", changes: [remove], client: "tab-1" },
		});
		expect(parseCommitRequest({ id: "c1", changes: [remove] })).toEqual({
			ok: true,
			value: { id: "c1", changes: [remove] },
		});
	});

	it.each([
		["オブジェクトでない", [remove]],
		["changes がない", { id: "c1", client: "tab-1" }],
		["コミットのIDがない", { changes: [] }],
		["コミットのIDに使えない文字がある", { id: "a b", changes: [] }],
		["端末の識別子に使えない文字がある", { id: "c1", changes: [], client: "a b" }],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parseCommitRequest(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseClientId", () => {
	it("英数字と _ - からなる 64 文字までの識別子を受け付ける", () => {
		expect(parseClientId("tab_1-a")).toEqual({ ok: true, value: "tab_1-a" });
	});

	it.each([[""], ["a b"], ["a".repeat(65)], [null]])("%j は受け付けない", (input) => {
		expect(parseClientId(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parsePageId", () => {
	it("英数字と _ - からなる 64 文字までのIDを受け付ける", () => {
		expect(parsePageId("0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual({
			ok: true,
			value: "0f8fad5b-d9cb-469f-a165-70867728950e",
		});
	});

	it.each([[""], ["a b"], ["a/b"], ["a".repeat(65)], [null]])("%j は受け付けない", (input) => {
		expect(parsePageId(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parsePageInfo", () => {
	it("ページのID、名前、名前を1行目に合わせられない理由を受け付ける", () => {
		const named = { id: "p1", title: "買い物 メモ", problem: null };
		const blocked = { id: "p1", title: "買い物 メモ", problem: "taken" };

		expect(parsePageInfo(named)).toEqual({ ok: true, value: named });
		expect(parsePageInfo(blocked)).toEqual({ ok: true, value: blocked });
		for (const problem of ["empty", "too-long", "reserved"]) {
			expect(parsePageInfo({ ...named, problem }).ok).toBe(true);
		}
	});

	it.each([
		["IDがない", { title: "a", problem: null }],
		["名前が文字列でない", { id: "p1", title: 1, problem: null }],
		["知らない理由", { id: "p1", title: "a", problem: "other" }],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parsePageInfo(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseClientMessage", () => {
	it("カーソルの位置を受け付ける", () => {
		const message = { type: "cursor", cursor: { line: "c1-0", column: 3 } };

		expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
	});

	it("カーソルを出していないこと(null)を受け付ける", () => {
		expect(parseClientMessage('{"type":"cursor","cursor":null}')).toEqual({
			ok: true,
			value: { type: "cursor", cursor: null },
		});
	});

	it.each([
		["JSONでない", "hello?"],
		["文字列でない", new ArrayBuffer(1)],
		["知らない種類", '{"type":"commit","version":1,"applied":[]}'],
		["カーソルがない", '{"type":"cursor"}'],
		["行IDに使えない文字がある", '{"type":"cursor","cursor":{"line":"a b","column":0}}'],
		["位置が整数でない", '{"type":"cursor","cursor":{"line":"a","column":1.5}}'],
		["位置が負", '{"type":"cursor","cursor":{"line":"a","column":-1}}'],
		[
			"位置が行の長さの上限より後ろ",
			`{"type":"cursor","cursor":{"line":"a","column":${MAX_LINE_LENGTH + 1}}}`,
		],
	])("%sメッセージは受け付けない", (_name, input) => {
		expect(parseClientMessage(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseCursorPosition", () => {
	it("カーソルの位置か、null を受け付ける", () => {
		expect(parseCursorPosition({ line: "a", column: 0 })).toEqual({
			ok: true,
			value: { line: "a", column: 0 },
		});
		expect(parseCursorPosition(null)).toEqual({ ok: true, value: null });
	});

	it.each([[undefined], ["a"], [{ line: "a" }]])("%j は受け付けない", (input) => {
		expect(parseCursorPosition(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseServerMessage", () => {
	it("接続したときのあいさつ(いまのバージョン)を受け付ける", () => {
		expect(parseServerMessage('{"type":"hello","version":3}')).toEqual({
			ok: true,
			value: { type: "hello", version: 3 },
		});
	});

	it("他の人のコミットを受け付ける", () => {
		const message = { type: "commit", version: 4, applied: [update] };

		expect(parseServerMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
	});

	it("他の端末のカーソルの位置を受け付ける。カーソルを出していなければ null", () => {
		const moved = { type: "cursor", client: "tab-1", cursor: { line: "c1-0", column: 3 } };
		const hidden = { type: "cursor", client: "tab-1", cursor: null };

		expect(parseServerMessage(JSON.stringify(moved))).toEqual({ ok: true, value: moved });
		expect(parseServerMessage(JSON.stringify(hidden))).toEqual({ ok: true, value: hidden });
	});

	it("ページの名前の知らせを受け付ける", () => {
		const message = { type: "page", title: "買い物", problem: "empty" };

		expect(parseServerMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
	});

	it("他の端末が接続を閉じた知らせを受け付ける", () => {
		const message = { type: "leave", client: "tab-1" };

		expect(parseServerMessage(JSON.stringify(message))).toEqual({ ok: true, value: message });
	});

	it.each([
		["JSONでない", "pong"],
		["知らない種類", '{"type":"bye"}'],
		["端末の識別子がないカーソル", '{"type":"cursor","cursor":null}'],
		["形が違う", '{"type":"commit","version":4}'],
		["文字列でない", new ArrayBuffer(1)],
	])("%sメッセージは受け付けない", (_name, input) => {
		expect(parseServerMessage(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("変更の検査", () => {
	it("4種類の変更を受け付ける", () => {
		const changes = [insert, update, remove, move];

		expect(parseChanges(changes)).toEqual({ ok: true, value: changes });
	});

	it("本文を置き換える変更は、元にした本文(base)を持てる", () => {
		const changes = [
			{ ...update, base: "題" },
			{ ...update, base: "" },
		];

		expect(parseChanges(changes)).toEqual({ ok: true, value: changes });
	});

	it("定義にない項目は取り除く", () => {
		expect(parseChanges([{ ...remove, extra: 1 }])).toEqual({ ok: true, value: [remove] });
	});

	it.each([
		["配列でない", { changes: [] }],
		["知らない種類", [{ type: "replace", id: "a" }]],
		["行IDが空", [{ type: "delete", id: "" }]],
		["行IDに使えない文字がある", [{ type: "delete", id: "a b" }]],
		["行IDが長すぎる", [{ type: "delete", id: "a".repeat(65) }]],
		["本文が文字列でない", [{ type: "update", id: "a", text: 1 }]],
		["本文に改行がある", [{ type: "update", id: "a", text: "a\nb" }]],
		["本文が長すぎる", [{ type: "update", id: "a", text: "a".repeat(MAX_LINE_LENGTH + 1) }]],
		["元にした本文が文字列でない", [{ ...update, base: 1 }]],
		["元にした本文に改行がある", [{ ...update, base: "a\nb" }]],
		["元にした本文が長すぎる", [{ ...update, base: "a".repeat(MAX_LINE_LENGTH + 1) }]],
		["位置がない", [{ type: "move", id: "a" }]],
		["変更が多すぎる", Array.from({ length: MAX_CHANGES + 1 }, () => remove)],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parseChanges(input)).toEqual({ ok: false, error: "invalid" });
	});

	it("上限ちょうどの長さの本文と変更の数は受け付ける", () => {
		const text = "a".repeat(MAX_LINE_LENGTH);

		expect(parseChanges([{ type: "update", id: "a", text }]).ok).toBe(true);
		expect(parseChanges(Array.from({ length: MAX_CHANGES }, () => remove)).ok).toBe(true);
	});
});

describe("parseSnapshot", () => {
	it("バージョンと行を受け付ける", () => {
		const snapshot = { version: 2, lines: [{ id: "a", text: "A" }] };

		expect(parseSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
	});

	it.each([
		["バージョンが負", { version: -1, lines: [] }],
		["バージョンが整数でない", { version: 1.5, lines: [] }],
		["行がない", { version: 1 }],
	])("%sなら受け付けない", (_name, input) => {
		expect(parseSnapshot(input)).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseCommitResult", () => {
	it("バージョンと、効いた変更を受け付ける", () => {
		const result = { version: 3, applied: [update] };

		expect(parseCommitResult(result)).toEqual({ ok: true, value: result });
	});

	it("形が違えば受け付けない", () => {
		expect(parseCommitResult({ version: 3 })).toEqual({ ok: false, error: "invalid" });
	});
});

describe("parseCommitResult(重複)", () => {
	it("以前に受け付けていたコミットだという印を受け付ける", () => {
		const result = { version: 3, applied: [], duplicate: true };

		expect(parseCommitResult(result)).toEqual({ ok: true, value: result });
	});
});

describe("parsePendingRecord", () => {
	const entry = { inflight: { id: "c1", changes: [update] }, changes: [remove] };

	it("端末内に残した未送信の変更(JSONの文字列)を受け付ける", () => {
		const record = { savedAt: 1000, entries: [entry, { inflight: null, changes: [] }] };

		expect(parsePendingRecord(JSON.stringify(record))).toEqual({ ok: true, value: record });
	});

	it("変更を残した端末の識別子(origin)を持てる", () => {
		const record = { savedAt: 1, entries: [{ ...entry, origin: "tab-1" }] };

		expect(parsePendingRecord(JSON.stringify(record))).toEqual({ ok: true, value: record });
	});

	it("変更を残した端末の識別子に使えない文字があれば、受け付けない", () => {
		const record = { savedAt: 1, entries: [{ ...entry, origin: "a b" }] };

		expect(parsePendingRecord(JSON.stringify(record))).toEqual({ ok: false, error: "invalid" });
	});

	it("送れない長さの本文も受け付ける(復元して、直してもらうため)", () => {
		const long = "a".repeat(MAX_LINE_LENGTH + 1);
		const changes = [{ type: "update", id: "a", text: long, base: `${long}b` }];
		const record = { savedAt: 1, entries: [{ inflight: { id: "c1", changes }, changes }] };

		expect(parsePendingRecord(JSON.stringify(record)).ok).toBe(true);
	});

	it("変更の数が多くても受け付ける(送るときに分ける)", () => {
		const changes = Array.from({ length: MAX_CHANGES + 1 }, () => remove);
		const record = { savedAt: 1, entries: [{ inflight: null, changes }] };

		expect(parsePendingRecord(JSON.stringify(record)).ok).toBe(true);
	});

	it.each([
		["JSONでない", "{"],
		["時刻がない", JSON.stringify({ entries: [] })],
		["以前の形の記録", JSON.stringify({ savedAt: 1, changes: [] })],
		[
			"形の違う変更",
			JSON.stringify({ savedAt: 1, entries: [{ inflight: null, changes: [{ type: "delete" }] }] }),
		],
		[
			"IDのない送信中のコミット",
			JSON.stringify({ savedAt: 1, entries: [{ inflight: { changes: [] }, changes: [] }] }),
		],
		["文字列でない", null],
	])("%s記録は受け付けない", (_name, input) => {
		expect(parsePendingRecord(input)).toEqual({ ok: false, error: "invalid" });
	});
});
