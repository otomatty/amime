import type { Identity } from "@amime/shared";

/**
 * ログインの提供元(OpenID Connect の認可コードの流れ)。
 * 提供元ごとの違いを、ここに閉じ込める(ADR-0009: 認証は、差し替えられる層にする)。
 */
export type LoginProvider = {
	/** 利用者を送り出す、提供元のログイン画面のURL。 */
	authorizeUrl(input: {
		readonly state: string;
		readonly nonce: string;
		readonly challenge: string;
		readonly redirectUri: string;
	}): string;
	/** 戻ってきたときの code を、本人の情報に引き換える。確かめられなければ null。 */
	identify(input: {
		readonly code: string;
		readonly verifier: string;
		readonly nonce: string;
		readonly redirectUri: string;
		/** いまの時刻(ミリ秒)。 */
		readonly now: number;
	}): Promise<Identity | null>;
};
