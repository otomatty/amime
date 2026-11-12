import { type Line, type PageSnapshot, startTracking, withPending } from "@amime/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "../editor/editor.tsx";
import { createIdPrefix } from "../editor/editor-model.ts";
import { createPageApi } from "./api.ts";
import { createChannel } from "./channel.ts";
import { createClientId } from "./client-id.ts";
import { PageApiError } from "./page-api-error.ts";
import { createPageSync, type PageApi, type SyncStatus } from "./page-sync.ts";
import {
	browserLocks,
	browserStorage,
	createPendingStore,
	type PendingStore,
} from "./pending-store.ts";
import { titleFromName } from "./route.ts";
import "./page.css";

type PageProps = {
	/** ページ名。URLのパスから求めたもの。 */
	readonly name: string;
};

type Loaded =
	| { readonly status: "loading" }
	| {
			readonly status: "ready";
			readonly snapshot: PageSnapshot;
			/** 前回送れなかった変更を載せた文書。復元するものがなければ null。 */
			readonly restored: readonly Line[] | null;
	  }
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
	// 端末(タブ)の識別子は、ページを開くたびに作る。
	const { api, pending } = useMemo(() => {
		const client = createClientId();
		return {
			api: createPageApi(name, client),
			pending: createPendingStore({
				storage: browserStorage(),
				locks: browserLocks(),
				page: name,
				client,
			}),
		};
	}, [name]);
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);

	// このタブが開いているあいだ、このタブの未送信の変更を、他のタブに引き取らせない(ADR-0020)。
	useEffect(() => pending.hold(), [pending]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt は、読み込みをやり直すためのきっかけとして使う。
	useEffect(() => {
		let cancelled = false;
		setLoaded({ status: "loading" });
		// 前回送れなかった変更が端末内に残っていたら、引き取って、読み込んだページに載せる(ADR-0020)。
		Promise.all([api.load(), pending.adopt()]).then(
			([snapshot, records]) => {
				if (cancelled) return;
				const document = withPending(snapshot.lines, records);
				const restored = document === snapshot.lines ? null : document;
				setLoaded({ status: "ready", snapshot, restored });
			},
			(error: unknown) => {
				const kind = error instanceof PageApiError ? error.kind : "failed";
				if (!cancelled) setLoaded({ status: "error", kind });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [api, pending, attempt]);

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
	return (
		<PageEditor
			title={titleFromName(name)}
			snapshot={loaded.snapshot}
			restored={loaded.restored}
			api={api}
			pending={pending}
		/>
	);
}

type PageEditorProps = {
	/** まだないページを開いたときに、1行目に入れるタイトル。 */
	readonly title: string;
	readonly snapshot: PageSnapshot;
	readonly restored: readonly Line[] | null;
	readonly api: PageApi;
	readonly pending: PendingStore;
};

function PageEditor({ title, snapshot, restored, api, pending }: PageEditorProps) {
	// まだないページは、タイトルだけを入れた仮の文書から始める。この内容のままなら保存しない。
	const placeholder = restored === null && snapshot.lines.length === 0;
	const initial = useMemo(() => {
		if (restored !== null) return restored;
		return placeholder ? startTracking([title], createIdPrefix()).lines : snapshot.lines;
	}, [snapshot, restored, placeholder, title]);
	const [status, setStatus] = useState<SyncStatus>(snapshot.version === 0 ? "new" : "saved");
	// 他の人の変更を取り込んだ文書を、編集欄へその場で届ける通り道。
	const [remote] = useState(() => createChannel<readonly Line[]>());
	const sync = useRef<ReturnType<typeof createPageSync> | null>(null);

	useEffect(() => {
		const current = createPageSync({
			snapshot,
			initial,
			placeholder,
			api,
			onStatus: setStatus,
			onRemote: remote.emit,
			// まだサーバーに入っていない変更を、端末内に残す。タブを閉じても、次に開いたときに送れる。
			onPending: pending.save,
		});
		sync.current = current;
		// 通信が戻ったら、再試行を待たずにすぐ保存する。
		const flush = () => current.flush();
		window.addEventListener("online", flush);
		return () => {
			window.removeEventListener("online", flush);
			current.dispose();
			sync.current = null;
		};
	}, [snapshot, initial, placeholder, api, remote, pending]);

	const unsaved = !SETTLED.has(status);
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
			<p className="page-status" role="status" data-status={status}>
				{STATUS_LABELS[status]}
			</p>
			{restored !== null && (
				<p className="page-notice" role="note">
					前回、送信できなかった変更を復元しました。
				</p>
			)}
			<Editor initialDocument={initial} remote={remote} onChange={handleChange} />
		</>
	);
}
