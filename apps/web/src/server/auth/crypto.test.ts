import { describe, expect, it } from "vitest";
import { decodeJsonSegment, hashToken, pkceChallenge, randomToken } from "./crypto.ts";

const encode = (text: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(text)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");

describe("randomToken", () => {
	it("URLに使える文字だけの、推測できない値を作る(256ビットなら43文字)", () => {
		const token = randomToken();

		expect(token).toMatch(/^[\w-]{43}$/);
		expect(randomToken()).not.toBe(token);
		expect(randomToken(16)).toMatch(/^[\w-]{22}$/);
	});
});

describe("hashToken", () => {
	it("SHA-256 を16進で返す", async () => {
		expect(await hashToken("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("pkceChallenge", () => {
	it("秘密の SHA-256 を、URLに使える Base64 で返す(RFC 7636 の例)", async () => {
		expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});
});

describe("decodeJsonSegment", () => {
	it("URLに使える Base64 で書かれたJSONを読む(日本語も、記号が - や _ になる値も)", () => {
		const value = { name: "山田 花子", note: "???>>>" };

		expect(decodeJsonSegment(encode(JSON.stringify(value)))).toEqual(value);
	});

	it.each([
		["Base64 ではない", "!!!"],
		["JSONではない", encode("not json")],
		["UTF-8 として読めない", btoa(String.fromCharCode(0xff, 0xfe))],
	])("%sものは、null を返す", (_name, segment) => {
		expect(decodeJsonSegment(segment)).toBeNull();
	});
});
