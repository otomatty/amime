import type { ProjectInfo } from "@amime/sync";
import { type ReactNode, useEffect, useState } from "react";
import { useAccount } from "../account/account.tsx";
import { type LoadedProject, loadProject } from "./api.ts";

type ProjectGateProps = {
	/** プロジェクトの名前(URLの最初の部分)。 */
	readonly name: string;
	/** 読めるプロジェクトだと分かってから、中身を作る。 */
	readonly children: (project: ProjectInfo) => ReactNode;
};

/**
 * プロジェクトを読めることを確かめてから、中身を表示する(ADR-0033)。
 * ないプロジェクトと、見る権限のないプロジェクトは、同じ案内にする(あることを、知らせない)。
 */
export function ProjectGate({ name, children }: ProjectGateProps) {
	const { state } = useAccount();
	const [attempt, setAttempt] = useState(0);
	// 読み込んだ結果は、だれに対するものかと一緒に持つ。利用者が変わったら、前の人への結果は使わない
	// (ログアウトしたあとに、前の人に見せていた中身を、出したままにしない)。
	const [result, setResult] = useState<{
		readonly user: string | null;
		readonly loaded: LoadedProject;
	} | null>(null);
	// ログインの状態が分かってから、読み込む。利用者が変わったら(ログイン、ログアウト)、読み直す。
	const known = state !== null;
	const user = state?.user?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt は、読み直すきっかけとして使う。
	useEffect(() => {
		if (!known) return;
		let cancelled = false;
		void loadProject(name).then((loaded) => {
			if (!cancelled) setResult({ user, loaded });
		});
		return () => {
			cancelled = true;
		};
	}, [name, attempt, user, known]);
	const loaded = known && result?.user === user ? result.loaded : null;

	if (loaded === null) {
		return (
			<p className="page-status" role="status">
				読み込んでいます…
			</p>
		);
	}
	if (loaded.status === "ready") return children(loaded.project);
	if (loaded.status === "missing") {
		return (
			<p className="page-message">
				このプロジェクトは、ないか、見る権限がありません。
				{state?.user === null && "ログインすると、見られることがあります。"}
				<a href="/">トップ</a>へ戻れます。
			</p>
		);
	}
	return (
		<p className="page-message">
			プロジェクトを読み込めませんでした。
			<button type="button" onClick={() => setAttempt((count) => count + 1)}>
				もう一度読み込む
			</button>
		</p>
	);
}
