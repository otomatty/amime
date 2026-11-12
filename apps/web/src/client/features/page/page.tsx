import type { Line, PageSnapshot } from "@amime/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "../editor/editor.tsx";
import { createPageApi, PageApiError } from "./api.ts";
import { createPageSync, type PageApi, type PageSyncState, type SyncStatus } from "./page-sync.ts";
import { titleFromName } from "./route.ts";
import "./page.css";

type PageProps = {
	/** ページ名。URLのパスから求めたもの。 */
	readonly name: string;
};

type Loaded =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly snapshot: PageSnapshot }
	| { readonly status: "error"; readonly kind: PageApiError["kind"] };

const STATUS_LABELS: Record<SyncStatus, string> = {
	saved: "保存済み",
	unsaved: "未保存の変更があります",
	saving: "保存しています…",
	retrying: "保存できませんでした。自動で再試行します",
};

/** 保存されるページ。読み込んでから編集欄を表示し、編集を保存する。 */
export function Page({ name }: PageProps) {
	const api = useMemo(() => createPageApi(name), [name]);
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt は、読み込みをやり直すためのきっかけとして使う。
	useEffect(() => {
		let cancelled = false;
		setLoaded({ status: "loading" });
		api.load().then(
			(snapshot) => {
				if (!cancelled) setLoaded({ status: "ready", snapshot });
			},
			(error: unknown) => {
				const kind = error instanceof PageApiError ? error.kind : "failed";
				if (!cancelled) setLoaded({ status: "error", kind });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [api, attempt]);

	if (loaded.status === "loading") {
		return (
			<p className="page-status" role="status">
				読み込んでいます…
			</p>
		);
	}
	if (loaded.status === "error") {
		return loaded.kind === "disabled" ? (
			<p className="page-message">
				この環境では、ページの保存と読み込みはまだ使えません。ログインの仕組みができるまで、公開している環境では止めています。
				<a href="/">試し書きのページ</a>は使えます。
			</p>
		) : (
			<p className="page-message">
				ページを読み込めませんでした。
				<button type="button" onClick={() => setAttempt((count) => count + 1)}>
					もう一度読み込む
				</button>
			</p>
		);
	}
	return <PageEditor title={titleFromName(name)} snapshot={loaded.snapshot} api={api} />;
}

type PageEditorProps = {
	/** まだないページを開いたときに、1行目に入れるタイトル。 */
	readonly title: string;
	readonly snapshot: PageSnapshot;
	readonly api: PageApi;
};

function PageEditor({ title, snapshot, api }: PageEditorProps) {
	const [state, setState] = useState<PageSyncState>({ status: "saved", remote: null });
	// まだないページは、書き始めるまで保存しない(開いただけではページを作らない)。
	const [started, setStarted] = useState(snapshot.version > 0);
	const sync = useRef<ReturnType<typeof createPageSync> | null>(null);

	useEffect(() => {
		const current = createPageSync({ snapshot, api, onState: setState });
		sync.current = current;
		// 通信が戻ったら、再試行を待たずにすぐ保存する。
		const flush = () => current.flush();
		window.addEventListener("online", flush);
		return () => {
			window.removeEventListener("online", flush);
			current.dispose();
			sync.current = null;
		};
	}, [snapshot, api]);

	const unsaved = state.status !== "saved";
	useEffect(() => {
		if (!unsaved) return;
		// 未保存の変更があるあいだは、ページを離れる前にブラウザの確認を出す。
		const confirmLeave = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", confirmLeave);
		return () => window.removeEventListener("beforeunload", confirmLeave);
	}, [unsaved]);

	const handleChange = useCallback((lines: readonly Line[]) => {
		setStarted(true);
		sync.current?.edit(lines);
	}, []);

	return (
		<>
			<p className="page-status" role="status" data-status={state.status}>
				{started ? STATUS_LABELS[state.status] : "新しいページです。書き始めると保存されます"}
			</p>
			<Editor
				initialDocument={snapshot.lines}
				initialLines={[title]}
				remote={state.remote}
				onChange={handleChange}
			/>
		</>
	);
}
