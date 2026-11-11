import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
	it("稼働中であることを返す", async () => {
		const response = await exports.default.fetch("https://amime.test/api/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});

describe("未定義のAPIパス", () => {
	it("JSONの404を返す", async () => {
		const response = await exports.default.fetch("https://amime.test/api/unknown");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not-found" });
	});
});
