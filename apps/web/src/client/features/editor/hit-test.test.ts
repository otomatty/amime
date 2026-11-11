import { describe, expect, it } from "vitest";
import { columnFromPoint } from "./hit-test.ts";

describe("columnFromPoint", () => {
	const char = { start: 3, end: 5, left: 100, width: 20 };

	it("文字の左半分を押したら、その文字の前", () => {
		expect(columnFromPoint(char, 100)).toBe(3);
		expect(columnFromPoint(char, 109)).toBe(3);
	});

	it("文字の右半分を押したら、その文字の後ろ", () => {
		expect(columnFromPoint(char, 110)).toBe(5);
		expect(columnFromPoint(char, 120)).toBe(5);
	});

	it("幅を測れない環境では、その文字の前", () => {
		expect(columnFromPoint({ ...char, left: 0, width: 0 }, 50)).toBe(3);
	});
});
