import { describe, expect, it } from "vitest";
import { readJson, sameSite } from "./context.ts";

describe("sameSite", () => {
	it.each([
		["同じサイト", "https://amime.test", "https://amime.test/api/me", true],
		["ホストが違う", "https://evil.example", "https://amime.test/api/me", false],
		["スキームが違う", "http://amime.test", "https://amime.test/api/me", false],
		["ポートが違う", "https://amime.test:8443", "https://amime.test/api/me", false],
		["Origin が URL ではない", "null", "https://amime.test/api/me", false],
	])("%s", (_name, origin, url, expected) => {
		expect(sameSite(origin, url)).toBe(expected);
	});
});

describe("readJson", () => {
	const request = (body: string) => new Request("https://amime.test/", { method: "POST", body });

	it("本文をJSONとして読む", async () => {
		expect(await readJson(request('{"a":1}'))).toEqual({ a: 1 });
	});

	it("JSONとして読めなければ、null を返す", async () => {
		expect(await readJson(request("{"))).toBeNull();
	});
});
