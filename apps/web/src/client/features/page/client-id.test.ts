import { parseClientId } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { createClientId } from "./client-id.ts";

describe("createClientId", () => {
	it("サーバーが受け付ける形の識別子を作る", () => {
		expect(parseClientId(createClientId()).ok).toBe(true);
	});

	it("呼ぶたびに違う識別子を作る", () => {
		expect(createClientId()).not.toBe(createClientId());
	});
});
