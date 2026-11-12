import { describe, expect, it } from "vitest";
import {
	MAX_CHANGES,
	MAX_LINE_LENGTH,
	parseChanges,
	parseCommitResult,
	parseSnapshot,
} from "./schema.ts";

const insert = { type: "insert", line: { id: "c1-0", text: "題" }, after: null, before: "c1-1" };
const update = { type: "update", id: "c1-0", text: "題2" };
const remove = { type: "delete", id: "c1-0" };
const move = { type: "move", id: "c1-0", after: "c1-1", before: null };

describe("parseChanges", () => {
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
