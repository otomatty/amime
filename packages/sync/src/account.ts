import { err, ok, type Result } from "@amime/shared";
import * as v from "valibot";

/** 利用者のID。 */
export type UserId = string & { readonly __brand: "UserId" };

/** ログインしている本人の情報。 */
export type Account = {
	readonly id: UserId;
	readonly name: string;
	readonly email: string;
	/** アイコンの画像のURL。なければ null。 */
	readonly picture: string | null;
};

/** ログインの方法。dev は、手元での開発と自動テストでだけ使える。 */
export type LoginMethod = "google" | "dev";

/** ログインの状態と、この環境で使えるログインの方法。 */
export type AccountState = {
	readonly user: Account | null;
	readonly login: readonly LoginMethod[];
};

const UserIdSchema = v.pipe(
	v.string(),
	v.regex(/^[\w-]{1,64}$/),
	v.transform((value) => value as UserId),
);

const AccountStateSchema = v.object({
	user: v.nullable(
		v.object({
			id: UserIdSchema,
			name: v.string(),
			email: v.string(),
			picture: v.nullable(v.string()),
		}),
	),
	login: v.array(v.picklist(["google", "dev"])),
});

/** サーバーから届いた、ログインの状態を検査する。 */
export function parseAccountState(input: unknown): Result<AccountState, "invalid"> {
	const parsed = v.safeParse(AccountStateSchema, input);
	return parsed.success ? ok(parsed.output) : err("invalid");
}
