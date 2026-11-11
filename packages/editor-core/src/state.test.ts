import { InvariantError } from "@amime/shared";
import { describe, expect, it } from "vitest";
import { lineAtCursor } from "./state.ts";

describe("lineAtCursor", () => {
	it("カーソルのある行の本文を返す", () => {
		expect(lineAtCursor({ lines: ["a", "b"], cursor: { line: 1, column: 1 } })).toBe("b");
	});

	it("カーソルの行が範囲外なら不変条件違反", () => {
		expect(() => lineAtCursor({ lines: ["a"], cursor: { line: 1, column: 0 } })).toThrow(
			InvariantError,
		);
	});

	it("カーソルの文字位置が範囲外なら不変条件違反", () => {
		expect(() => lineAtCursor({ lines: ["a"], cursor: { line: 0, column: 2 } })).toThrow(
			InvariantError,
		);
		expect(() => lineAtCursor({ lines: ["a"], cursor: { line: 0, column: -1 } })).toThrow(
			InvariantError,
		);
	});
});
