import { describe, expect, it } from "vitest";
import { PageApiError } from "./page-api-error.ts";

describe("PageApiError", () => {
	it("失敗の種類を持つ", () => {
		const error = new PageApiError("rejected");

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: "PageApiError", kind: "rejected" });
	});
});
