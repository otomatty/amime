import { describe, expect, it } from "vitest";
import { formatSavedAt } from "./saved-at.ts";

describe("formatSavedAt(端末内に変更を残した時刻)", () => {
	it("月、日、時刻を、短く書く", () => {
		const savedAt = new Date(2026, 10, 16, 9, 5).getTime();

		expect(formatSavedAt(savedAt)).toBe("11月16日 09:05");
	});
});
