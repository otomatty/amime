import { describe, expect, it } from "vitest";
import { InvariantError } from "./invariant.ts";
import { itemAt } from "./item-at.ts";

describe("itemAt", () => {
	it("指定した位置の要素を返す", () => {
		expect(itemAt(["a", "b"], 1)).toBe("b");
	});

	it("範囲外なら InvariantError を投げる", () => {
		expect(() => itemAt(["a"], 1)).toThrow(InvariantError);
		expect(() => itemAt(["a"], -1)).toThrow("index -1 is out of range");
	});
});
