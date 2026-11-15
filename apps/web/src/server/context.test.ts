import { describe, expect, it } from "vitest";
import { readJson, sameSite } from "./context.ts";

describe("sameSite", () => {
	it.each([
		["同じサイト", "https://tsuzuri.test", "https://tsuzuri.test/api/me", true],
		["ホストが違う", "https://evil.example", "https://tsuzuri.test/api/me", false],
		["スキームが違う", "http://tsuzuri.test", "https://tsuzuri.test/api/me", false],
		["ポートが違う", "https://tsuzuri.test:8443", "https://tsuzuri.test/api/me", false],
		["Origin が URL ではない", "null", "https://tsuzuri.test/api/me", false],
	])("%s", (_name, origin, url, expected) => {
		expect(sameSite(origin, url)).toBe(expected);
	});
});

describe("readJson", () => {
	const request = (body: string) => new Request("https://tsuzuri.test/", { method: "POST", body });

	it("本文をJSONとして読む", async () => {
		expect(await readJson(request('{"a":1}'))).toEqual({ a: 1 });
	});

	it("JSONとして読めなければ、null を返す", async () => {
		expect(await readJson(request("{"))).toBeNull();
	});
});
