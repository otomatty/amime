import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const get = (path: string, headers: Record<string, string> = {}) =>
	exports.default.fetch(`https://amime.test${path}`, { headers });

describe("GET /api/health", () => {
	it("稼働中であることを返す", async () => {
		const response = await get("/api/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});

describe("未定義のAPIパス", () => {
	it("JSONの404を返す", async () => {
		const response = await get("/api/unknown");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not-found" });
	});
});

describe("ログインの状態を読むAPI", () => {
	it("稼働の確認は、ログインの状態を読まない(データベースを使わない)", async () => {
		const response = await get("/api/health", { origin: "https://evil.example" });

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBeNull();
	});

	it("そのほかのAPIは、他のサイトからの要求を断り、応答をキャッシュさせない", async () => {
		const foreign = await get("/api/projects", { origin: "https://evil.example" });
		const own = await get("/api/projects");

		expect(foreign.status).toBe(403);
		expect(own.headers.get("cache-control")).toBe("no-store");
	});
});
