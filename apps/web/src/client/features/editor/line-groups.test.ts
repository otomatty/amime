import type { LineKind } from "@amime/parser";
import { describe, expect, it } from "vitest";
import { groupLines } from "./line-groups.ts";

const group = (kinds: LineKind[]) => groupLines(kinds);

describe("groupLines", () => {
	it("行がなければグループもない", () => {
		expect(group([])).toEqual([]);
	});

	it("テーブルのない行の並びは、1つのグループになる", () => {
		expect(group(["title", "text", "code-head", "code-body"])).toEqual([
			{ table: false, start: 0, end: 4 },
		]);
	});

	it("連続するテーブルの行を1つのグループにまとめる(始まりの行は含めない)", () => {
		expect(group(["title", "table-head", "table-row", "table-row", "text"])).toEqual([
			{ table: false, start: 0, end: 2 },
			{ table: true, start: 2, end: 4 },
			{ table: false, start: 4, end: 5 },
		]);
	});

	it("テーブルが続けて2つあれば、別々のグループになる", () => {
		expect(group(["title", "table-head", "table-row", "table-head", "table-row"])).toEqual([
			{ table: false, start: 0, end: 2 },
			{ table: true, start: 2, end: 3 },
			{ table: false, start: 3, end: 4 },
			{ table: true, start: 4, end: 5 },
		]);
	});
});
