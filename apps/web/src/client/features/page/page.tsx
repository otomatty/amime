import {
	type CursorPosition,
	type Line,
	type PageId,
	type PageInfo,
	type PageLinks,
	type PageSnapshot,
	startTracking,
	type TitleProblem,
} from "@amime/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "../editor/editor.tsx";
import { createIdPrefix } from "../editor/editor-model.ts";
import { pageHref } from "../editor/links.ts";
import { createPageApi, loadLinks, openPage } from "./api.ts";
import { createChannel } from "./channel.ts";
import { createClientId } from "./client-id.ts";
import { createCommitId } from "./commit-id.ts";
import { PageApiError } from "./page-api-error.ts";
import { createPageSync, type PageApi, type SyncStatus } from "./page-sync.ts";
import { PageTools } from "./page-tools.tsx";
import {
	browserLocks,
	browserStorage,
	createPendingStore,
	type PendingStore,
} from "./pending-store.ts";
import { createPresence, type RemoteCursor } from "./presence.ts";
import { RelatedPages } from "./related-pages.tsx";
import { restorePage } from "./restore.ts";
import "./page.css";

type PageProps = {
	/** ページ名。URLのパスから求めたもの。 */
	readonly name: string;
};

/** サーバーからの読み込みの進み具合。 */
type Loading<T> =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly value: T }
	| { readonly status: "error"; readonly kind: PageApiError["kind"]; readonly retry: () => void };

/** 読み込みを行い、進み具合を返す。load が変わると、読み込み直す。 */
function useLoading<T>(load: () => Promise<T>): Loading<T> {
	const [state, setState] = useState<Loading<T>>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt は、読み込みをやり直すためのきっかけとして使う。
	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		load().then(
			(value) => {
				if (!cancelled) setState({ status: "ready", value });
			},
			(error: unknown) => {
				const kind = error instanceof PageApiError ? error.kind : "failed";
				const retry = () => setAttempt((count) => count + 1);
				if (!cancelled) setState({ status: "error", kind, retry });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [load, attempt]);

	return state;
}

/** 読み込みが終わっていないあいだの表示。終わっていれば null。 */
function Pending({ state }: { readonly state: Loading<unknown> }) {
	if (state.status === "loading") {
		return (
			<p className="page-status" role="status">
				読み込んでいます…
			</p>
		);
	}
	if (state.status === "ready") return null;
	if (state.kind === "gone") {
		return (
			<p className="page-message">
				このページは削除されました。<a href="/">ページの一覧</a>へ戻れます。
			</p>
		);
	}
	return state.kind === "disabled" ? (
		<p className="page-message">
			この環境では、ページの保存と読み込みはまだ使えません。ログインの仕組みができるまで、公開している環境では止めています。
			<a href="/">試し書きのページ</a>は使えます。
		</p>
	) : (
		<p className="page-message">
			ページを読み込めませんでした。
			<button type="button" onClick={state.retry}>
				もう一度読み込む
			</button>
		</p>
	);
}

const STATUS_LABELS: Record<SyncStatus, string> = {
	new: "新しいページです。書き始めると保存されます",
	saved: "保存済み",
	unsaved: "未保存の変更があります",
	saving: "保存しています…",
	retrying: "保存できませんでした。自動で再試行します",
	rejected:
		"保存できない内容があります。1行が20,000文字を超えていないか確かめてください。直すと保存されます",
	deleted: "このページは削除されました。ここに書いても、保存されません",
};

/** 他の人の変更やカーソルを受け取る接続(WebSocket)の状態。 */
type Connection = "connecting" | "online" | "offline";

const CONNECTION_LABELS: Record<Connection, string> = {
	connecting: "接続しています…",
	online: "オンライン",
	offline: "オフライン(つなぎ直しています…)",
};

/** ページの名前を1行目に合わせられないときの案内(ADR-0024)。 */
const TITLE_PROBLEMS: Record<TitleProblem, string> = {
	taken: "1行目と同じ名前のページが、すでにあります。",
	empty: "1行目が空です。",
	"too-long": "1行目が長すぎて、ページの名前にできません(200文字まで)。",
	reserved: "「.」と「..」は、ページの名前にできません。",
};

/** 保存を待っている変更がない状態。ページを離れても何も失われない(削除されたページは、保存する先がない)。 */
const SETTLED: ReadonlySet<SyncStatus> = new Set(["new", "saved", "deleted"]);
/** ページの操作(固定、削除)を出さない状態。まだ保存されていないページと、削除されたページ。 */
const WITHOUT_TOOLS: ReadonlySet<SyncStatus> = new Set(["new", "deleted"]);

/**
 * 保存されるページ。URLの中の名前からページを引き、読み込んでから編集欄を表示する。
 * ページは、名前を変えても変わらないIDで識別する(ADR-0024)。
 */
export function Page({ name }: PageProps) {
	const opened = useLoading(useCallback(() => openPage(name), [name]));
	if (opened.status !== "ready") return <Pending state={opened} />;
	return <OpenedPage key={opened.value.id} info={opened.value} />;
}

/** IDの分かったページ。保存されている内容を読み込み、前回送れなかった変更を復元する。 */
function OpenedPage({ info }: { readonly info: PageInfo }) {
	// 端末(タブ)の識別子は、ページを開くたびに作る。
	const { api, pending } = useMemo(() => {
		const client = createClientId();
		return {
			api: createPageApi(info.id, client),
			pending: createPendingStore({
				storage: browserStorage(),
				locks: browserLocks(),
				page: info.id,
				client,
			}),
		};
	}, [info.id]);

	// このタブが開いているあいだ、このタブの未送信の変更を、他のタブに引き取らせない(ADR-0020)。
	useEffect(() => pending.hold(), [pending]);

	// 前回送れなかった変更が端末内に残っていたら、復元する(ADR-0020)。
	const loaded = useLoading(useCallback(() => restorePage(api, pending), [api, pending]));
	if (loaded.status !== "ready") return <Pending state={loaded} />;
	return (
		<PageEditor
			info={info}
			snapshot={loaded.value.snapshot}
			restored={loaded.value.restored}
			noticed={loaded.value.noticed}
			api={api}
			pending={pending}
		/>
	);
}

const NO_LINKS: PageLinks = { missing: [], related: [], hops: [] };

/**
 * ページのつながり(ADR-0027)。開いたときに取り出す。refresh を呼ぶと、取り出し直す。
 * 取り出せなくても、ページは読み書きできる。そのときは、前に取り出したものをそのまま使う。
 */
function useLinks(id: PageId) {
	const [links, setLinks] = useState(NO_LINKS);
	// まだないページの名前。中身が同じなら同じものを保ち、行を描き直させない。
	const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
	// 取り出し直すたびに進める。あとから届いた古い応答で、新しい内容を上書きしない。
	const latest = useRef(0);
	const refresh = useCallback(() => {
		latest.current += 1;
		const started = latest.current;
		loadLinks(id).then(
			(loaded) => {
				if (latest.current !== started) return;
				setLinks(loaded);
				setMissing((current) =>
					current.size === loaded.missing.length &&
					loaded.missing.every((title) => current.has(title))
						? current
						: new Set(loaded.missing),
				);
			},
			() => {},
		);
	}, [id]);
	useEffect(() => {
		refresh();
		return () => {
			latest.current += 1;
		};
	}, [refresh]);
	return { links, missing, refresh };
}

type PageEditorProps = {
	/** 台帳にある、ページのIDと名前。まだないページを開いたときは、名前を1行目に入れる。 */
	readonly info: PageInfo;
	readonly snapshot: PageSnapshot;
	readonly restored: readonly Line[] | null;
	readonly noticed: boolean;
	readonly api: PageApi;
	readonly pending: PendingStore;
};

function PageEditor({ info, snapshot, restored, noticed, api, pending }: PageEditorProps) {
	// ページを開いたときの名前。まだないページの1行目に入れる(あとで名前が変わっても、入れ直さない)。
	const [title] = useState(info.title);
	// ページのいまの名前と、名前を1行目に合わせられない理由。1行目を変えると、サーバーが名前を合わせて知らせてくる。
	const [named, setNamed] = useState({ title: info.title, problem: info.problem });
	const [pinned, setPinned] = useState(info.pinned);
	const { links, missing, refresh: refreshLinks } = useLinks(info.id);
	useEffect(() => {
		// URLを、ページのいまの名前に合わせる。再読み込みしても、共有しても、同じページが開く。
		const target = new URL(pageHref(named.title), window.location.href);
		if (target.pathname !== window.location.pathname) {
			window.history.replaceState(window.history.state, "", target);
		}
	}, [named.title]);
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
	const [connection, setConnection] = useState<Connection>("connecting");
	// 同じページを開いている、他の人のカーソル(ADR-0023)。
	const [others, setOthers] = useState<readonly RemoteCursor[]>([]);

	useEffect(() => {
		const presence = createPresence(setOthers);
		const current = createPageSync({
			snapshot,
			initial,
			placeholder,
			api,
			listeners: {
				onCursor: presence.onCursor,
				onLeave: presence.onLeave,
				onConnection(connected) {
					presence.onConnection(connected);
					setConnection(connected ? "online" : "offline");
				},
				// サーバーは、台帳への反映が済むたびに、名前が変わっていなくても知らせてくる。
				onPage(title, problem) {
					// 同じなら、描き直さない。
					setNamed((current) =>
						current.title === title && current.problem === problem ? current : { title, problem },
					);
					// リンクのつながりも、台帳に反映されている。取り出し直す。
					refreshLinks();
				},
			},
			onStatus: setStatus,
			onRemote: remote.emit,
			// まだサーバーに入っていない変更を、端末内に残す。タブを閉じても、次に開いたときに送れる。
			onPending: pending.save,
			createCommitId,
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
	}, [snapshot, initial, placeholder, api, remote, pending, refreshLinks]);

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
	const handleCursor = useCallback((cursor: CursorPosition | null) => {
		sync.current?.sendCursor(cursor);
	}, []);

	return (
		<>
			{!WITHOUT_TOOLS.has(status) && (
				<PageTools id={info.id} pinned={pinned} onPinned={setPinned} />
			)}
			<p className="page-status" role="status" data-status={status}>
				{STATUS_LABELS[status]}
			</p>
			{/* 保存の状態(上)とは別に示す。切れていても、書いたものは端末内に残り、つながったら送られる。 */}
			<p className="page-connection" data-testid="connection" data-connection={connection}>
				{CONNECTION_LABELS[connection]}
			</p>
			{named.problem !== null && (
				<p className="page-notice" role="note" data-testid="title-problem">
					{TITLE_PROBLEMS[named.problem]}
					このページの名前は「{named.title}」のままです。1行目を変えると、ページの名前も変わります。
				</p>
			)}
			{noticed && (
				<p className="page-notice" role="note">
					前回、送信できなかった変更を復元しました。
				</p>
			)}
			<Editor
				initialDocument={initial}
				remote={remote}
				onChange={handleChange}
				others={others}
				onCursor={handleCursor}
				missingLinks={missing}
			/>
			<RelatedPages links={links} />
		</>
	);
}
