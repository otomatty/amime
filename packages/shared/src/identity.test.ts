import { describe, expect, it } from "vitest";
import { parseDisplayName, parsePictureUrl, readIdentity } from "./identity.ts";

describe("parseDisplayName(表示名)", () => {
	it("前後の空白を取り除く", () => {
		expect(parseDisplayName("  山田 花子  ")).toBe("山田 花子");
	});

	it.each([
		["文字列ではない", 1],
		["空", ""],
		["空白だけ", "   "],
		["長すぎる", "あ".repeat(51)],
		["改行が入っている", "花子\n太郎"],
	])("%sものは、受け付けない", (_name, value) => {
		expect(parseDisplayName(value)).toBeNull();
	});

	it("50文字までは、受け付ける(絵文字も、1文字として数える)", () => {
		expect(parseDisplayName("あ".repeat(50))).toBe("あ".repeat(50));
		expect(parseDisplayName("😀".repeat(50))).toBe("😀".repeat(50));
	});
});

describe("parsePictureUrl(アイコンの画像のURL)", () => {
	it("https のURLを受け付ける", () => {
		expect(parsePictureUrl("https://images.example/a.png?x=1")).toBe(
			"https://images.example/a.png?x=1",
		);
	});

	it.each([
		["文字列ではない", null],
		["http", "http://images.example/a.png"],
		["スクリプト", "javascript:alert(1)"],
		["データ", "data:image/png;base64,AAAA"],
		["空白が入っている", "https://images.example/a b.png"],
		["長すぎる", `https://images.example/${"a".repeat(1000)}`],
	])("%sものは、受け付けない", (_name, value) => {
		expect(parsePictureUrl(value)).toBeNull();
	});
});

const expected = {
	issuers: ["https://accounts.example", "accounts.example"],
	audience: "client-1",
	nonce: "nonce-1",
	now: 1_000,
};
const claims = {
	iss: "https://accounts.example",
	aud: "client-1",
	exp: 1_600,
	nonce: "nonce-1",
	sub: "user-1",
	email: "Hanako@Example.com",
	email_verified: true,
	name: "山田 花子",
	picture: "https://images.example/hanako.png",
};

describe("readIdentity(ログインの結果として受け取った内容を確かめて、本人の情報を取り出す)", () => {
	it("正しい内容なら、本人の情報を返す。メールアドレスは小文字にそろえる", () => {
		expect(readIdentity(claims, expected)).toEqual({
			ok: true,
			value: {
				subject: "user-1",
				email: "hanako@example.com",
				name: "山田 花子",
				picture: "https://images.example/hanako.png",
			},
		});
	});

	it("発行者は、認めたもののどれかであればよい", () => {
		expect(readIdentity({ ...claims, iss: "accounts.example" }, expected).ok).toBe(true);
	});

	it("宛先が複数あっても、自分が含まれていればよい", () => {
		expect(readIdentity({ ...claims, aud: ["other", "client-1"] }, expected).ok).toBe(true);
	});

	it("名前がなければ、メールアドレスの @ より前を名前にする", () => {
		const { name: _name, ...rest } = claims;
		expect(readIdentity(rest, expected)).toMatchObject({ value: { name: "hanako" } });
		expect(readIdentity({ ...claims, name: "  " }, expected)).toMatchObject({
			value: { name: "hanako" },
		});
	});

	it("メールアドレスから作る名前も、長さを上限に収める", () => {
		const { name: _name, ...rest } = claims;
		expect(
			readIdentity({ ...rest, email: `${"a".repeat(80)}@example.com` }, expected),
		).toMatchObject({ value: { name: "a".repeat(50) } });
	});

	it("名前の前後の空白は取り除き、長すぎる名前は切り詰める", () => {
		expect(readIdentity({ ...claims, name: "  花子  " }, expected)).toMatchObject({
			value: { name: "花子" },
		});
		expect(readIdentity({ ...claims, name: "あ".repeat(200) }, expected)).toMatchObject({
			value: { name: "あ".repeat(50) },
		});
	});

	it.each([
		["ない", undefined],
		["https ではない", "http://images.example/a.png"],
		["URLではない", "not a url"],
		["長すぎる", `https://images.example/${"a".repeat(2000)}`],
	])("画像のURLが %s ときは、画像なしにする", (_name, picture) => {
		expect(readIdentity({ ...claims, picture }, expected)).toMatchObject({
			ok: true,
			value: { picture: null },
		});
	});

	it.each([
		["オブジェクトではない", "claims", "invalid-token"],
		["null", null, "invalid-token"],
		["発行者が違う", { ...claims, iss: "https://evil.example" }, "wrong-issuer"],
		["宛先が違う", { ...claims, aud: "client-2" }, "wrong-audience"],
		["宛先の形が違う", { ...claims, aud: 1 }, "wrong-audience"],
		["期限が切れている", { ...claims, exp: 1_000 }, "expired"],
		["期限がない", { ...claims, exp: "soon" }, "expired"],
		["ログインを始めたときの合言葉と違う", { ...claims, nonce: "other" }, "wrong-nonce"],
		["本人の識別子がない", { ...claims, sub: "" }, "invalid-subject"],
		["本人の識別子が長すぎる", { ...claims, sub: "s".repeat(256) }, "invalid-subject"],
		["メールアドレスがない", { ...claims, email: undefined }, "invalid-email"],
		["メールアドレスの形が違う", { ...claims, email: "hanako" }, "invalid-email"],
		[
			"メールアドレスが長すぎる",
			{ ...claims, email: `${"a".repeat(320)}@example.com` },
			"invalid-email",
		],
		["メールアドレスが確認されていない", { ...claims, email_verified: false }, "unverified-email"],
		[
			"メールアドレスの確認が文字列で届いた",
			{ ...claims, email_verified: "true" },
			"unverified-email",
		],
	])("%s ときは、受け取らない", (_name, value, error) => {
		expect(readIdentity(value, expected)).toEqual({ ok: false, error });
	});
});
