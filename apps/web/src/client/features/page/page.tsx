import { type Line, type PageSnapshot, startTracking } from "@amime/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "../editor/editor.tsx";
import { createIdPrefix } from "../editor/editor-model.ts";
import { createPageApi } from "./api.ts";
import { PageApiError } from "./page-api-error.ts";
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
	new: "新しいページです。書き始めると保存されます",
	saved: "保存済み",
	unsaved: "未保存の変更があります",
	saving: "保存しています…",
	retrying: "保存できませんでした。自動で再試行します",
	rejected:
		"保存できない内容があります。1行が20,000文字を超えていないか確かめてください。直すと保存されます",
};

/** 保存を待っている変更がない状態。ページを離れても何も失われない。 */
const SETTLED: ReadonlySet<SyncStatus> = new Set(["new", "saved"]);

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
	// まだないページは、タイトルだけを入れた文書から始める。この内容のままなら保存しない。
	const initial = useMemo(
		() =>
			snapshot.lines.length > 0 ? snapshot.lines : startTracking([title], createIdPrefix()).lines,
		[snapshot, title],
	);
	const [state, setState] = useState<PageSyncState>({
		status: snapshot.version === 0 ? "new" : "saved",
		remote: null,
	});
	const sync = useRef<ReturnType<typeof createPageSync> | null>(null);

	useEffect(() => {
		const current = createPageSync({ snapshot, initial, api, onState: setState });
		sync.current = current;
		// 通信が戻ったら、再試行を待たずにすぐ保存する。
		const flush = () => current.flush();
		window.addEventListener("online", flush);
		return () => {
			window.removeEventListener("online", flush);
			current.dispose();
			sync.current = null;
		};
	}, [snapshot, initial, api]);

	const unsaved = !SETTLED.has(state.status);
	useEffect(() => {
		if (!unsaved) return;
		// 未保存の変更があるあいだは、ページを離れる前にブラウザの確認を出す。
		const confirmLeave = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", confirmLeave);
		return () => window.removeEventListener("beforeunload", confirmLeave);
	}, [unsaved]);

	const handleChange = useCallback((lines: readonly Line[]) => {
		sync.current?.edit(lines);
	}, []);

	return (
		<>
			<p className="page-status" role="status" data-status={state.status}>
				{STATUS_LABELS[state.status]}
			</p>
			<Editor initialDocument={initial} remote={state.remote} onChange={handleChange} />
		</>
	);
}
