import { err, ok, type Result } from "./result.ts";

/** ログインで確かめられた、本人の情報。 */
export type Identity = {
	/** ログインの提供元が付けた、本人の識別子。 */
	readonly subject: string;
	/** 確認済みのメールアドレス(小文字)。 */
	readonly email: string;
	readonly name: string;
	/** プロフィールの画像のURL(https)。なければ null。 */
	readonly picture: string | null;
};

export type IdentityError =
	| "invalid-token"
	| "wrong-issuer"
	| "wrong-audience"
	| "expired"
	| "wrong-nonce"
	| "invalid-subject"
	| "invalid-email"
	| "unverified-email";

/** 受け取った内容が満たすべきこと。 */
export type ExpectedToken = {
	/** 認める発行者。 */
	readonly issuers: readonly string[];
	/** このアプリを表す宛先(クライアントID)。 */
	readonly audience: string;
	/** ログインを始めたときに決めた、1回かぎりの合言葉。 */
	readonly nonce: string;
	/** いまの時刻(秒)。 */
	readonly now: number;
};

/** 表示名の長さの上限。 */
const MAX_DISPLAY_NAME = 50;
const MAX_SUBJECT = 255;
const MAX_EMAIL = 320;
const MAX_PICTURE_URL = 1_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

function hasAudience(aud: unknown, audience: string): boolean {
	return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}

/** アイコンの画像のURL。https の、長すぎないURLなら、そのまま返す。ほかは null。 */
export function parsePictureUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_PICTURE_URL) return null;
	return /^https:\/\/[^\s/]+\/\S*$/.test(value) ? value : null;
}

/** 改行など、名前を2行に分けてしまう文字(制御文字、行の区切り、段落の区切り)。 */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** 改行などを空白に置き換え、前後の空白を取り除き、表示名の長さの上限に収める。 */
const clip = (text: string) =>
	[...text.replace(BREAKS, " ").trim()].slice(0, MAX_DISPLAY_NAME).join("").trim();

/**
 * 本人が決める表示名。前後の空白を取り除く。空のもの、長すぎるもの、改行などを含むものは null
 * (ログインの提供元から受け取る名前と違って、切り詰めずに断る)。
 */
export function parseDisplayName(value: unknown): string | null {
	if (typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return null;
	const name = value.trim();
	return name === "" || [...name].length > MAX_DISPLAY_NAME ? null : name;
}

/** 表示名。前後の空白を取り除き、長さを上限に収める。空なら null。 */
function displayName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = clip(value);
	return name === "" ? null : name;
}

/** 発行者・宛先・期限・合言葉が、期待したとおりか。 */
function tokenError(
	claims: Record<string, unknown>,
	expected: ExpectedToken,
): IdentityError | null {
	if (typeof claims["iss"] !== "string" || !expected.issuers.includes(claims["iss"])) {
		return "wrong-issuer";
	}
	if (!hasAudience(claims["aud"], expected.audience)) return "wrong-audience";
	if (typeof claims["exp"] !== "number" || claims["exp"] <= expected.now) return "expired";
	return claims["nonce"] === expected.nonce ? null : "wrong-nonce";
}

/**
 * ログインの結果として受け取った内容(IDトークンの中身)を確かめて、本人の情報を取り出す。
 * 署名は、ここでは確かめない(呼び出す側が、提供元から直接受け取ったものを渡す)。
 */
export function readIdentity(
	claims: unknown,
	expected: ExpectedToken,
): Result<Identity, IdentityError> {
	if (!isRecord(claims)) return err("invalid-token");
	const error = tokenError(claims, expected);
	if (error !== null) return err(error);
	const { sub, email } = claims;
	if (typeof sub !== "string" || sub === "" || sub.length > MAX_SUBJECT) {
		return err("invalid-subject");
	}
	if (typeof email !== "string" || email.length > MAX_EMAIL || !EMAIL.test(email)) {
		return err("invalid-email");
	}
	if (claims["email_verified"] !== true) return err("unverified-email");
	const address = email.toLowerCase();
	return ok({
		subject: sub,
		email: address,
		name: displayName(claims["name"]) ?? clip(address.slice(0, address.indexOf("@"))),
		picture: parsePictureUrl(claims["picture"]),
	});
}
