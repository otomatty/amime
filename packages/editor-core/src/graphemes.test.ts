import { describe, expect, it } from "vitest";
import {
	ceilToBoundary,
	nextBoundary,
	previousBoundary,
	segmentGraphemes,
	snapToBoundary,
} from "./graphemes.ts";

const THUMBS_UP = "👍"; // UTF-16 で2単位
const FAMILY = "👨‍👩‍👧"; // 結合された絵文字。UTF-16 で8単位
const E_ACUTE = `e${String.fromCharCode(0x301)}`; // e + 結合アクセント。2単位で1文字

describe("segmentGraphemes", () => {
	it("空文字列は空の配列", () => {
		expect(segmentGraphemes("")).toEqual([]);
	});

	it("利用者から見た1文字ごとに、文字と開始位置を返す", () => {
		expect(segmentGraphemes(`a${THUMBS_UP}あ`)).toEqual([
			{ text: "a", column: 0 },
			{ text: THUMBS_UP, column: 1 },
			{ text: "あ", column: 3 },
		]);
	});

	it("結合された絵文字や結合文字は1文字として扱う", () => {
		expect(segmentGraphemes(`${FAMILY}${E_ACUTE}`)).toEqual([
			{ text: FAMILY, column: 0 },
			{ text: E_ACUTE, column: 8 },
		]);
	});
});

describe("previousBoundary", () => {
	it("1つ前の文字の開始位置を返す", () => {
		expect(previousBoundary("abc", 2)).toBe(1);
	});

	it("絵文字の途中で止まらない", () => {
		expect(previousBoundary(`a${THUMBS_UP}`, 3)).toBe(1);
		expect(previousBoundary(FAMILY, 8)).toBe(0);
	});

	it("行頭ではそれ以上戻らない", () => {
		expect(previousBoundary("abc", 0)).toBe(0);
	});
});

describe("nextBoundary", () => {
	it("次の文字の終了位置を返す", () => {
		expect(nextBoundary("abc", 1)).toBe(2);
	});

	it("絵文字の途中で止まらない", () => {
		expect(nextBoundary(`a${THUMBS_UP}b`, 1)).toBe(3);
		expect(nextBoundary(E_ACUTE, 0)).toBe(2);
	});

	it("行末ではそれ以上進まない", () => {
		expect(nextBoundary("abc", 3)).toBe(3);
	});
});

describe("snapToBoundary", () => {
	it("文字の境界にある位置はそのまま返す", () => {
		expect(snapToBoundary(`a${THUMBS_UP}`, 1)).toBe(1);
		expect(snapToBoundary(`a${THUMBS_UP}`, 3)).toBe(3);
	});

	it("文字の途中にある位置は、その文字の開始位置に寄せる", () => {
		expect(snapToBoundary(`a${THUMBS_UP}`, 2)).toBe(1);
	});

	it("範囲外の位置は行の範囲に収める", () => {
		expect(snapToBoundary("abc", -1)).toBe(0);
		expect(snapToBoundary("abc", 99)).toBe(3);
	});
});

describe("ceilToBoundary", () => {
	it("文字の境界にある位置はそのまま返す", () => {
		expect(ceilToBoundary(`a${THUMBS_UP}`, 1)).toBe(1);
		expect(ceilToBoundary(`a${THUMBS_UP}`, 3)).toBe(3);
	});

	it("文字の途中にある位置は、その文字の終了位置に寄せる", () => {
		expect(ceilToBoundary(`a${THUMBS_UP}`, 2)).toBe(3);
		expect(ceilToBoundary(E_ACUTE, 1)).toBe(2);
	});

	it("範囲外の位置は行の範囲に収める", () => {
		expect(ceilToBoundary("abc", -1)).toBe(0);
		expect(ceilToBoundary("abc", 99)).toBe(3);
	});
});
