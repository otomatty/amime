import { describe, expect, it } from "vitest";
import { err, ok } from "./result.ts";

describe("Result", () => {
	it("ok は値を保持する", () => {
		expect(ok(1)).toEqual({ ok: true, value: 1 });
	});

	it("err はエラーを保持する", () => {
		expect(err("boom")).toEqual({ ok: false, error: "boom" });
	});
});
