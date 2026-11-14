import { useEffect, useState } from "react";
import { useAccount } from "../account/account.tsx";
import { loginHref } from "../account/api.ts";
import { acceptInvite, type LoadedInvite, loadInvite } from "./api.ts";
import "./project.css";

type InviteProps = {
	/** 招待リンクに入っている値。 */
	readonly token: string;
	/** 画面を移る。テストで差し替える。 */
	readonly navigate?: (href: string) => void;
};

/** 招待リンクを開いたときの画面。招待先を確かめて、参加する(ADR-0034)。 */
export function InvitePage({
	token,
	navigate = (href) => window.location.assign(href),
}: InviteProps) {
	const { state } = useAccount();
	const known = state !== null;
	const user = state?.user ?? null;
	const [loaded, setLoaded] = useState<LoadedInvite | null>(null);
	const [failed, setFailed] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: user は、読み直すきっかけとして使う(ログインすると、もうメンバーかが変わる)。
	useEffect(() => {
		if (!known) return;
		let cancelled = false;
		void loadInvite(token).then((result) => {
			if (!cancelled) setLoaded(result);
		});
		return () => {
			cancelled = true;
		};
	}, [token, known, user?.id]);

	if (loaded === null) {
		return (
			<p className="page-status" role="status">
				読み込んでいます…
			</p>
		);
	}
	if (loaded.status === "missing") {
		return (
			<p className="page-message">
				この招待リンクは、使えません(無効にされたか、期限が切れています)。招待した人に、新しいリンクを頼んでください。
			</p>
		);
	}
	if (loaded.status === "failed") {
		return (
			<p className="page-message">招待リンクを確かめられませんでした。再読み込みしてください。</p>
		);
	}
	const { project, member } = loaded.invite;
	const href = `/${project}/`;
	const join = async () => {
		const result = await acceptInvite(token);
		if (result.status === "ready") navigate(href);
		else if (result.status === "missing") setLoaded(result);
		else setFailed(true);
	};
	return (
		<section className="project-home" aria-labelledby="invite-title">
			<h2 id="invite-title">「{project}」への招待</h2>
			{member ? (
				<p>
					もう、このプロジェクトのメンバーです。<a href={href}>プロジェクトを開く</a>
				</p>
			) : user === null ? (
				<p>
					参加するには、ログインしてください。
					{state?.login.includes("google") && (
						<a href={loginHref("google", window.location.pathname)}>
							Google でログインして参加する
						</a>
					)}
				</p>
			) : (
				<>
					<p>{user.name} として、このプロジェクトに参加します。</p>
					<button type="button" className="primary" onClick={() => void join()}>
						参加する
					</button>
				</>
			)}
			{failed && (
				<p className="project-error" role="alert">
					参加できませんでした。もう一度お試しください。
				</p>
			)}
		</section>
	);
}
