import { describe, expect, it } from "vitest";
import { type CharBox, columnFromPoint, columnOnRow } from "./hit-test.ts";

describe("columnFromPoint", () => {
	const char = { start: 3, end: 5, left: 100, width: 20, top: 0, height: 20 };

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

describe("columnOnRow", () => {
	/** 3文字ずつ2段に折り返した行。1文字の幅は10、高さは20。 */
	const box = (start: number, row: number, slot: number): CharBox => ({
		start,
		end: start + 1,
		left: slot * 10,
		width: 10,
		top: row * 20,
		height: 20,
	});
	const wrapped = [
		box(0, 0, 0),
		box(1, 0, 1),
		box(2, 0, 2),
		box(3, 1, 0),
		box(4, 1, 1),
		box(5, 1, 2),
	];

	it("1段目の右の余白を押したら、1段目の末尾(行全体の末尾ではない)", () => {
		expect(columnOnRow(wrapped, 200, 10)).toBe(3);
	});

	it("2段目の右の余白を押したら、2段目の末尾", () => {
		expect(columnOnRow(wrapped, 200, 30)).toBe(6);
	});

	it("段の左の余白を押したら、その段の先頭", () => {
		expect(columnOnRow(wrapped, -5, 30)).toBe(3);
	});

	it("段の中の文字の上を押したら、その文字のどちら側かで決める", () => {
		expect(columnOnRow(wrapped, 12, 30)).toBe(4);
		expect(columnOnRow(wrapped, 18, 30)).toBe(5);
	});

	it("どの段にも当たらなければ null(呼び出し側で行末にする)", () => {
		expect(columnOnRow(wrapped, 10, 99)).toBeNull();
		expect(columnOnRow([], 10, 10)).toBeNull();
	});
});
