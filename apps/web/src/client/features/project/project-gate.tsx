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
	const [loaded, setLoaded] = useState<LoadedProject | null>(null);
	// ログインの状態が分かってから、読み込む。あとで変わったら(ログイン、ログアウト)、読み直す。
	const known = state !== null;
	const user = state?.user?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt と user は、読み直すきっかけとして使う。
	useEffect(() => {
		if (!known) return;
		let cancelled = false;
		// 読み直しているあいだは、前の表示のままにする(中身を作り直すと、入力の途中のものが消える)。
		void loadProject(name).then((result) => {
			if (!cancelled) setLoaded(result);
		});
		return () => {
			cancelled = true;
		};
	}, [name, attempt, user, known]);

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
