import type { Account, AccountState } from "@amime/sync";
import { type FormEvent, useState } from "react";
import "./account.css";
import { useAccount } from "./account.tsx";
import { devLogin, loginHref, logout } from "./api.ts";

/** ログインに失敗して戻ってきたときの案内。URLの ?login= の値ごと。 */
const LOGIN_NOTICES: ReadonlyMap<string | null, string> = new Map([
	["failed", "ログインできませんでした。もう一度お試しください。"],
	["unavailable", "この環境では、ログインの設定が済んでいません。"],
]);

/** 開発用のログイン。名前を入れるだけで、その名前の利用者になる。 */
function DevLogin({ onDone }: { readonly onDone: () => Promise<void> }) {
	const [name, setName] = useState("");
	const [failed, setFailed] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "") return;
		if (await devLogin(name.trim())) await onDone();
		else setFailed(true);
	};
	return (
		<form className="account-dev" onSubmit={(event) => void submit(event)}>
			<input
				aria-label="開発用ログインの名前"
				placeholder="名前(半角)"
				value={name}
				onChange={(event) => {
					setName(event.target.value);
					setFailed(false);
				}}
			/>
			<button type="submit">開発用ログイン</button>
			{failed && (
				<p className="account-notice" role="alert">
					ログインできませんでした。名前は、半角の英数字と「-」「_」で、40文字までにしてください。
				</p>
			)}
		</form>
	);
}

function SignedIn({
	user,
	onDone,
}: {
	readonly user: Account;
	readonly onDone: () => Promise<void>;
}) {
	return (
		<>
			<span className="account-user">
				{user.picture !== null && (
					// 名前が横にあるので、画像は飾り。画像の置き場所に、いまのページのURLを伝えない。
					<img className="account-picture" src={user.picture} alt="" referrerPolicy="no-referrer" />
				)}
				<span>{user.name}</span>
			</span>
			<button
				type="button"
				onClick={() => {
					void logout().then(onDone);
				}}
			>
				ログアウト
			</button>
		</>
	);
}

function SignedOut({
	login,
	onDone,
}: {
	readonly login: AccountState["login"];
	readonly onDone: () => Promise<void>;
}) {
	const here = `${window.location.pathname}${window.location.search}`;
	return (
		<>
			{login.includes("google") && <a href={loginHref("google", here)}>Google でログイン</a>}
			{login.includes("dev") && <DevLogin onDone={onDone} />}
		</>
	);
}

/** ヘッダーに置く、ログインの状態と、ログイン・ログアウトの操作(ADR-0032)。 */
export function AccountMenu() {
	const { state, refresh } = useAccount();
	if (state === null) return null;
	const notice = LOGIN_NOTICES.get(new URLSearchParams(window.location.search).get("login"));
	if (state.user === null && state.login.length === 0 && notice === undefined) return null;
	return (
		<div className="account">
			{notice !== undefined && state.user === null && (
				<p className="account-notice" role="alert">
					{notice}
				</p>
			)}
			{state.user === null ? (
				<SignedOut login={state.login} onDone={refresh} />
			) : (
				<SignedIn user={state.user} onDone={refresh} />
			)}
		</div>
	);
}
