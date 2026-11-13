import type { Identity } from "@amime/shared";
import type { Account, UserId } from "@amime/sync";
import { hashToken, randomToken } from "./crypto.ts";

/** ログインの状態を保つ長さ(ミリ秒)。使い続けているあいだは、延びる。 */
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
/** 期限を延ばす間隔(ミリ秒)。要求のたびには、書き込まない。 */
const RENEW_AFTER = 24 * 60 * 60 * 1000;

/**
 * ログインの提供元の本人に当たる利用者を返す。いなければ、作る。
 * メールアドレスは、ログインのたびに新しいものにする。名前と画像は、最初のログインのときのものを保つ
 * (あとから本人が変えられるものなので、上書きしない)。
 */
export async function signIn(
	db: D1Database,
	provider: string,
	identity: Identity,
	now: number,
): Promise<UserId> {
	const row = await db
		.prepare(
			`INSERT INTO users (id, provider, subject, email, name, picture, created)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email
			RETURNING id`,
		)
		.bind(
			randomToken(16),
			provider,
			identity.subject,
			identity.email,
			identity.name,
			identity.picture,
			now,
		)
		.first<{ id: UserId }>();
	if (row === null) throw new Error("the user was not saved");
	return row.id;
}

/** ログインの状態を作り、Cookie に入れる値を返す。期限の切れたものは、ついでに消す。 */
export async function startSession(db: D1Database, user: UserId, now: number): Promise<string> {
	const token = randomToken();
	await db.batch([
		db.prepare("DELETE FROM sessions WHERE expires <= ?").bind(now),
		db
			.prepare("INSERT INTO sessions (id, user, created, expires) VALUES (?, ?, ?, ?)")
			.bind(await hashToken(token), user, now, now + SESSION_TTL),
	]);
	return token;
}

/**
 * Cookie の値から、ログインしている利用者を引く。期限が切れていれば null。
 * しばらく延ばしていなければ、期限を延ばす(renewed が true。Cookie も出し直す)。
 */
export async function findSession(
	db: D1Database,
	token: string,
	now: number,
): Promise<{ account: Account; renewed: boolean } | null> {
	const id = await hashToken(token);
	const row = await db
		.prepare(
			`SELECT u.id, u.name, u.email, u.picture, s.expires
			FROM sessions s JOIN users u ON u.id = s.user
			WHERE s.id = ? AND s.expires > ?`,
		)
		.bind(id, now)
		.first<Account & { expires: number }>();
	if (row === null) return null;
	const { expires, ...account } = row;
	const renewed = expires - now < SESSION_TTL - RENEW_AFTER;
	if (renewed) {
		await db
			.prepare("UPDATE sessions SET expires = ? WHERE id = ?")
			.bind(now + SESSION_TTL, id)
			.run();
	}
	return { account, renewed };
}

/** ログインの状態を消す(ログアウト)。 */
export async function endSession(db: D1Database, token: string): Promise<void> {
	await db
		.prepare("DELETE FROM sessions WHERE id = ?")
		.bind(await hashToken(token))
		.run();
}
