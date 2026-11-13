import type { Account } from "@amime/sync";
import { type FormEvent, useState } from "react";
import "./account.css";
import { useAccount } from "./account.tsx";
import { type ProfileError, updateProfile } from "./api.ts";

const ERRORS: Record<ProfileError, string> = {
	"invalid-name": "表示名は、1文字から50文字までにしてください。",
	"invalid-picture": "アイコンの画像は、https:// で始まるURLで指定してください。",
	failed: "保存できませんでした。もう一度お試しください。",
};

function ProfileForm({
	user,
	onSaved,
}: {
	readonly user: Account;
	readonly onSaved: () => Promise<void>;
}) {
	const [name, setName] = useState(user.name);
	const [picture, setPicture] = useState(user.picture ?? "");
	const [result, setResult] = useState<ProfileError | "saved" | null>(null);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const url = picture.trim();
		const error = await updateProfile({ name, picture: url === "" ? null : url });
		setResult(error ?? "saved");
		if (error === null) await onSaved();
	};
	const edit = (change: () => void) => {
		change();
		setResult(null);
	};
	return (
		<form className="profile-form" onSubmit={(event) => void submit(event)}>
			<label>
				表示名(他の人のカーソルや、メンバーの一覧に出ます)
				<input
					value={name}
					maxLength={50}
					onChange={(event) => edit(() => setName(event.target.value))}
				/>
			</label>
			<label>
				アイコンの画像のURL(空にすると、アイコンなし)
				<input
					type="url"
					value={picture}
					placeholder="https://"
					onChange={(event) => edit(() => setPicture(event.target.value))}
				/>
			</label>
			{picture.trim().startsWith("https://") && (
				<p className="profile-preview">
					<img
						className="account-picture"
						src={picture.trim()}
						alt="アイコンの見本"
						referrerPolicy="no-referrer"
					/>
				</p>
			)}
			<p className="profile-hint">
				本文に <code>[{name.trim() || "表示名"}.icon]</code>{" "}
				と書くと、参加しているプロジェクトのページに、このアイコンを置けます。
			</p>
			<button type="submit">保存する</button>
			{result === "saved" && (
				<p className="page-status" role="status">
					保存しました
				</p>
			)}
			{result !== null && result !== "saved" && (
				<p className="account-notice" role="alert">
					{ERRORS[result]}
				</p>
			)}
		</form>
	);
}

/** 自分の表示名とアイコンを変える画面(ADR-0035)。 */
export function Profile() {
	const { state, refresh } = useAccount();
	if (state === null) return null;
	if (state.user === null) {
		return <p className="page-message">プロフィールを変えるには、ログインしてください。</p>;
	}
	return (
		<section className="project-home" aria-labelledby="profile-title">
			<h2 id="profile-title">プロフィール</h2>
			<p className="profile-hint">ログインしているアカウント: {state.user.email}</p>
			<ProfileForm key={state.user.id} user={state.user} onSaved={refresh} />
		</section>
	);
}
