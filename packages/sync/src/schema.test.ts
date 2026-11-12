import { describe, expect, it } from "vitest";
import {
	MAX_CHANGES,
	MAX_LINE_LENGTH,
	parseClientId,
	parseCommitRequest,
	parseCommitResult,
	parseServerMessage,
	parseSnapshot,
} from "./schema.ts";

const insert = { type: "insert", line: { id: "c1-0", text: "題" }, after: null, before: "c1-1" };
const update = { type: "update", id: "c1-0", text: "題2" };
const remove = { type: "delete", id: "c1-0" };
const move = { type: "move", id: "c1-0", after: "c1-1", before: null };

const parseChanges = (input: unknown) => {
	const parsed = parseCommitRequest({ changes: input });
	return parsed.ok ? { ok: true, value: parsed.value.changes } : parsed;
};

describe("parseCommitRequest", () => {
	it("送った端末の識別子を受け付ける。なくてもよい", () => {
		expect(parseCommitRequest({ changes: [remove], client: "tab-1" })).toEqual({
			ok: true,
			value: { changes: [remove], client: "tab-1" },
		});
		expect(parseCommitRequest({ changes: [remove] })).toEqual({
			ok: true,
			value: { changes: [remove] },
		});
	});

	it.each([
		["オブジェクトでない", [remove]],
		["changes がない", { client: "tab-1" }],
		["端末の識別子に使えない文字がある", { changes: [], client: "a b" }],
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

	it.each([
		["JSONでない", "pong"],
		["知らない種類", '{"type":"bye"}'],
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
