import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ready } from "../db/migrate.ts";
import { endSession, findSession, SESSION_TTL, signIn, startSession } from "./accounts.ts";

const DAY = 24 * 60 * 60 * 1000;
const identity = (subject: string) => ({
	subject,
	email: `${subject}@example.com`,
	name: subject,
	picture: null,
});
const unique = (name: string) => `${name}-${crypto.randomUUID()}`;

beforeAll(() => ready(env.DB));

describe("signIn", () => {
	it("提供元の本人ごとに、利用者を1人作る。同じ本人なら、同じ利用者を返す", async () => {
		const subject = unique("accounts");

		const first = await signIn(env.DB, "google", identity(subject), 1_000);
		const again = await signIn(env.DB, "google", identity(subject), 2_000);
		const otherProvider = await signIn(env.DB, "dev", identity(subject), 3_000);

		expect(first).toMatch(/^[\w-]{22}$/);
		expect(again).toBe(first);
		expect(otherProvider).not.toBe(first);
	});

	it("ログインし直すと、メールアドレスだけを新しくする(名前と画像は、変えない)", async () => {
		const subject = unique("accounts-update");
		const user = await signIn(env.DB, "google", identity(subject), 1_000);

		await signIn(
			env.DB,
			"google",
			{ subject, email: "new@example.com", name: "別の名前", picture: "https://x.example/a.png" },
			2_000,
		);

		const token = await startSession(env.DB, user, 2_000);
		expect((await findSession(env.DB, token, 2_000))?.account).toEqual({
			id: user,
			name: subject,
			email: "new@example.com",
			picture: null,
		});
	});
});

describe("ログインの状態", () => {
	it("作った状態は、期限まで使える。期限を過ぎたら使えない", async () => {
		const user = await signIn(env.DB, "dev", identity(unique("session")), 1_000);

		const token = await startSession(env.DB, user, 1_000);
		const unused = await startSession(env.DB, user, 1_000);

		expect(token).toMatch(/^[\w-]{43}$/);
		expect((await findSession(env.DB, token, 1_000))?.account.id).toBe(user);
		expect((await findSession(env.DB, token, 1_000 + SESSION_TTL - 1))?.account.id).toBe(user);
		// 使わないままのほうは、期限で使えなくなる。
		expect(await findSession(env.DB, unused, 1_000 + SESSION_TTL)).toBeNull();
		expect(await findSession(env.DB, "unknown", 1_000)).toBeNull();
	});

	it("データベースには、Cookie の値そのものを保存しない", async () => {
		const user = await signIn(env.DB, "dev", identity(unique("session-hash")), 1_000);

		const token = await startSession(env.DB, user, 1_000);

		const { results } = await env.DB.prepare("SELECT id FROM sessions WHERE user = ?")
			.bind(user)
			.all<{ id: string }>();
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toMatch(/^[0-9a-f]{64}$/);
		expect(results[0]?.id).not.toBe(token);
	});

	it("1日以上たってから使うと、期限を延ばす。それより前は、延ばさない", async () => {
		const user = await signIn(env.DB, "dev", identity(unique("session-renew")), 0);
		const token = await startSession(env.DB, user, 0);

		expect((await findSession(env.DB, token, DAY - 1))?.renewed).toBe(false);
		expect((await findSession(env.DB, token, 20 * DAY))?.renewed).toBe(true);

		// 延ばしたので、最初の期限(30日)を過ぎても使える。
		expect(await findSession(env.DB, token, 40 * DAY)).not.toBeNull();
	});

	it("消した状態は、使えない。ほかの端末の状態は、残る", async () => {
		const user = await signIn(env.DB, "dev", identity(unique("session-end")), 1_000);
		const here = await startSession(env.DB, user, 1_000);
		const there = await startSession(env.DB, user, 1_000);

		await endSession(env.DB, here);

		expect(await findSession(env.DB, here, 2_000)).toBeNull();
		expect(await findSession(env.DB, there, 2_000)).not.toBeNull();
	});

	it("新しい状態を作るときに、期限の切れたものを片付ける", async () => {
		const user = await signIn(env.DB, "dev", identity(unique("session-sweep")), 0);
		await startSession(env.DB, user, 0);
		const count = async () =>
			(
				await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user = ?")
					.bind(user)
					.first<{ n: number }>()
			)?.n;
		expect(await count()).toBe(1);

		await startSession(env.DB, user, SESSION_TTL + 1);

		expect(await count()).toBe(1);
	});
});
