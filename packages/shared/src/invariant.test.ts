import { describe, expect, it } from "vitest";
import { InvariantError, invariant } from "./invariant.ts";

describe("invariant", () => {
	it("条件が真なら何もしない", () => {
		expect(() => invariant(true, "unreachable")).not.toThrow();
	});

	it("条件が偽なら InvariantError を投げる", () => {
		expect(() => invariant(false, "cursor out of range")).toThrow(InvariantError);
		expect(() => invariant(false, "cursor out of range")).toThrow("cursor out of range");
	});
});
