import type { LineId } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { caretsByLine, colorOf, REMOTE_COLORS } from "./remote-carets.ts";

const at = (client: string, line: string, column: number) => ({
	client,
	line: line as LineId,
	column,
});

describe("colorOf(人ごとの色の番号)", () => {
	it("同じ人は、いつも同じ番号になる", () => {
		expect(colorOf("tab-1")).toBe(colorOf("tab-1"));
	});

	it("番号は、用意した色の数に収まる", () => {
		for (const client of ["", "a", "tab-1", "0f8fad5b-d9cb-469f-a165-70867728950e", "日本語"]) {
			const color = colorOf(client);

			expect(Number.isInteger(color)).toBe(true);
			expect(color).toBeGreaterThanOrEqual(0);
			expect(color).toBeLessThan(REMOTE_COLORS);
		}
	});

	it("人が違えば、番号はばらける", () => {
		const colors = new Set(Array.from({ length: 64 }, (_, index) => colorOf(`tab-${index}`)));

		expect(colors.size).toBe(REMOTE_COLORS);
	});
});

describe("caretsByLine", () => {
	it("他の人のカーソルを、行ごとにまとめる", () => {
		const byLine = caretsByLine([at("bob", "a", 1), at("carol", "b", 0), at("dave", "a", 4)]);

		expect(byLine.get("a" as LineId)).toEqual([
			{ key: "bob", column: 1, color: colorOf("bob") },
			{ key: "dave", column: 4, color: colorOf("dave") },
		]);
		expect(byLine.get("b" as LineId)).toEqual([
			{ key: "carol", column: 0, color: colorOf("carol") },
		]);
		expect(byLine.size).toBe(2);
	});

	it("だれもいなければ、空", () => {
		expect(caretsByLine([]).size).toBe(0);
	});
});
