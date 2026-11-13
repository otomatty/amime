import { describe, expect, it } from "vitest";
import { parseAccountState } from "./account.ts";

describe("parseAccountState(サーバーから届いた、ログインの状態を検査する)", () => {
	const user = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };

	it("ログインしている状態を受け付ける", () => {
		const state = { user: { ...user, picture: "https://images.example/a.png" }, login: ["google"] };

		expect(parseAccountState(state)).toEqual({ ok: true, value: state });
	});

	it("ログインしていない状態を受け付ける", () => {
		const state = { user: null, login: ["google", "dev"] };

		expect(parseAccountState(state)).toEqual({ ok: true, value: state });
	});

	it.each([
		["オブジェクトでない", "x"],
		["user がない", { login: [] }],
		["利用者のIDの形が違う", { user: { ...user, id: "a b" }, login: [] }],
		["名前が文字列でない", { user: { ...user, name: 1 }, login: [] }],
		["知らないログインの方法", { user: null, login: ["password"] }],
	])("%s入力は受け付けない", (_name, input) => {
		expect(parseAccountState(input)).toEqual({ ok: false, error: "invalid" });
	});
});
