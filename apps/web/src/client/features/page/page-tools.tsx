import type { PageId } from "@amime/sync";
import { useState } from "react";
import { deletePage, pinPage } from "./api.ts";

type PageToolsProps = {
	readonly id: PageId;
	/** 一覧の先頭に固定しているか。 */
	readonly pinned: boolean;
	/** 固定した・固定を外した。 */
	readonly onPinned: (pinned: boolean) => void;
	/** 別のページへ移る。テストで差し替える。 */
	readonly navigate?: (href: string) => void;
};

/**
 * ページの操作(ADR-0026)。一覧の先頭への固定と、ページの削除。
 * 削除は元に戻せないので、押しただけでは行わず、確かめてから行う。
 */
export function PageTools({
	id,
	pinned,
	onPinned,
	navigate = (href) => window.location.assign(href),
}: PageToolsProps) {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	/** 操作を行う。行っているあいだは、他の操作を受け付けない。失敗したら、そのことを伝える。 */
	const run = async (operation: () => Promise<void>) => {
		setBusy(true);
		setFailed(false);
		try {
			await operation();
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
		}
	};
	const togglePin = () =>
		run(async () => {
			const info = await pinPage(id, !pinned);
			onPinned(info.pinned);
		});
	const remove = () =>
		run(async () => {
			await deletePage(id);
			// プロジェクトのトップ(ページの一覧)へ戻る。
			navigate("./");
		});

	return (
		<div className="page-tools">
			{confirming ? (
				<>
					<span>このページを削除しますか? 削除すると、元には戻せません。</span>
					<button type="button" className="danger" disabled={busy} onClick={remove}>
						削除する
					</button>
					<button type="button" disabled={busy} onClick={() => setConfirming(false)}>
						やめる
					</button>
				</>
			) : (
				<>
					<button type="button" aria-pressed={pinned} disabled={busy} onClick={togglePin}>
						{pinned ? "固定を外す" : "一覧の先頭に固定する"}
					</button>
					<button type="button" disabled={busy} onClick={() => setConfirming(true)}>
						このページを削除
					</button>
				</>
			)}
			{failed && (
				<span role="alert">できませんでした。少し待ってから、もう一度試してください。</span>
			)}
		</div>
	);
}
