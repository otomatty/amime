import {
	type CursorPosition,
	type Line,
	type PageId,
	type PageInfo,
	type PageLinks,
	type PageSnapshot,
	type PendingPageSummary,
	startTracking,
	strayPages,
	type TitleProblem,
} from "@tsuzuri/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "../editor/editor.tsx";
import { createIdPrefix } from "../editor/editor-model.ts";
import { createIconSource, IconSourceProvider } from "../editor/icons.tsx";
import { pageHref } from "../editor/links.ts";
import { currentProject } from "../project/route.ts";
import { createPageApi, findPage, loadIcon, loadLinks, openPage, searchTitles } from "./api.ts";
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
	listPendingRecords,
	type PendingStore,
} from "./pending-store.ts";
import { createPresence, type RemoteCursor } from "./presence.ts";
import { RelatedPages } from "./related-pages.tsx";
import { restorePage } from "./restore.ts";
import { formatSavedAt } from "./saved-at.ts";
import "./page.css";

type PageProps = (
	| {
			/** ページ名。URLのパスから求めたもの。 */
			readonly name: string;
	  }
	| {
			/** ページID。端末内に残った変更のページを、IDで開くとき(URLの ?page=。ADR-0042)。 */
			readonly id: PageId;
	  }
) & {
	/** 読むだけにするか(メンバーでない人が、公開のプロジェクトを見ている)。 */
	readonly readOnly?: boolean;
};

/** 開いたページ。unlisted は、台帳にない(1度も保存できなかった)ページを、端末内の記録の名前で開いたか。 */
type OpenedInfo = PageInfo & { readonly unlisted?: boolean };

/**
 * IDからページを引く(ADR-0042)。台帳になければ(通信できないまま書いて、1度も保存できなかった)、
 * 端末内の記録の名前で開く。送れば、台帳に載る(名前が重なれば、重ならない名前で載る。ADR-0024)。
 */
async function openPageById(id: PageId): Promise<OpenedInfo> {
	try {
		return await findPage(id);
	} catch (error) {
		if (!(error instanceof PageApiError) || error.kind !== "missing") throw error;
		const project = currentProject() ?? "";
		const [record] = listPendingRecords(browserStorage())
			.filter((stored) => stored.project === project && stored.id === id)
			.sort((a, b) => b.savedAt - a.savedAt);
		if (record === undefined) throw error;
		return { id, title: record.title, problem: null, pinned: false, unlisted: true };
	}
}

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
				このページは削除されました。<a href="./">ページの一覧</a>へ戻れます。
			</p>
		);
	}
	if (state.kind === "missing") {
		return (
			<p className="page-message">
				このページは、まだありません。<a href="./">ページの一覧</a>へ戻れます。
			</p>
		);
	}
	return state.kind === "disabled" ? (
		<p className="page-message">
			このページを見る権限がありません。ログインし直すと、見られることがあります。
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
	denied:
		"保存できません。このプロジェクトに書き込む権限がなくなりました。書いたものは、この端末に残っています。権限が戻ったら、再読み込みしてください",
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
const WITHOUT_TOOLS: ReadonlySet<SyncStatus> = new Set(["new", "deleted", "denied"]);

/**
 * 保存されるページ。URLの中の名前からページを引き、読み込んでから編集欄を表示する。
 * ページは、名前を変えても変わらないIDで識別する(ADR-0024)。
 */
export function Page(props: PageProps) {
	const { readOnly = false } = props;
	const name = "name" in props ? props.name : null;
	const id = "id" in props ? props.id : null;
	const opened = useLoading(
		useCallback<() => Promise<OpenedInfo>>(
			() => (id !== null ? openPageById(id) : openPage(name ?? "")),
			[id, name],
		),
	);
	const [icons] = useState(() => createIconSource(loadIcon));
	if (opened.status !== "ready") return <Pending state={opened} />;
	// 読むだけの表示と、書ける表示を切り替えたときは、ページを開き直す(端末の識別子も、作り直す)。
	// 書ける表示に戻ったときに、前に残した未送信の変更を、閉じたタブのものと同じように引き取って送る。
	const mode = readOnly ? "read" : "write";
	return (
		// `[名前.icon]` の画像は、このプロジェクトから引く(ADR-0035)。同じ名前は、1回だけ引く。
		<IconSourceProvider source={icons}>
			<OpenedPage key={`${opened.value.id}:${mode}`} info={opened.value} readOnly={readOnly} />
		</IconSourceProvider>
	);
}

/** IDの分かったページ。保存されている内容を読み込み、前回送れなかった変更を復元する。 */
function OpenedPage({ info, readOnly }: { readonly info: OpenedInfo; readonly readOnly: boolean }) {
	// 端末(タブ)の識別子は、ページを開くたびに作る。
	// 名前が変わっても作り直さない(端末内の記録の名前は、retitle で直す)。info.title は、作るときの名前にだけ使う。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 名前が変わるたびに作り直すと、端末の識別子と、引き取った記録を失う
	const { api, pending } = useMemo(() => {
		const client = createClientId();
		return {
			api: createPageApi(info.id, client),
			pending: createPendingStore({
				storage: browserStorage(),
				locks: browserLocks(),
				project: currentProject() ?? "",
				page: info.id,
				title: info.title,
				client,
			}),
		};
	}, [info.id]);

	// このタブが開いているあいだ、このタブの未送信の変更を、他のタブに引き取らせない(ADR-0020)。
	// 読むだけの表示では、端末内の未送信の変更に触れない。
	useEffect(() => (readOnly ? undefined : pending.hold()), [pending, readOnly]);

	// 前回送れなかった変更が端末内に残っていたら、復元する(ADR-0020)。
	// 読むだけの表示では、復元しない(送れないので、ページを開けなくなる)。メンバーとして開き直したときに、送る。
	const loaded = useLoading(
		useCallback(
			() =>
				readOnly
					? api.load().then((snapshot) => ({ snapshot, restored: null, noticed: false }))
					: restorePage(api, pending),
			[api, pending, readOnly],
		),
	);
	if (loaded.status !== "ready") return <Pending state={loaded} />;
	return (
		<PageEditor
			info={info}
			snapshot={loaded.value.snapshot}
			restored={loaded.value.restored}
			noticed={loaded.value.noticed}
			api={api}
			pending={pending}
			readOnly={readOnly}
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
	readonly info: OpenedInfo;
	readonly snapshot: PageSnapshot;
	readonly restored: readonly Line[] | null;
	readonly noticed: boolean;
	readonly api: PageApi;
	readonly pending: PendingStore;
	/** 読むだけにするか(メンバーでない人が、公開のプロジェクトを見ている)。 */
	readonly readOnly: boolean;
};

/** 端末内の未送信の変更を、そのままにする(読むだけの表示で使う)。 */
const keepPending = () => {};

function PageEditor({
	info,
	snapshot,
	restored,
	noticed,
	api,
	pending,
	readOnly,
}: PageEditorProps) {
	// ページを開いたときの名前。まだないページの1行目に入れる(あとで名前が変わっても、入れ直さない)。
	const [title] = useState(info.title);
	// ページのいまの名前と、名前を1行目に合わせられない理由。1行目を変えると、サーバーが名前を合わせて知らせてくる。
	const [named, setNamed] = useState({ title: info.title, problem: info.problem });
	const [pinned, setPinned] = useState(info.pinned);
	const { links, missing, refresh: refreshLinks } = useLinks(info.id);
	// 台帳にないページ(IDで開いた)は、台帳が名前を決めて知らせてくるまで、URLを変えない。
	// その名前は、別のページが使っている(ADR-0042)。先にURLを変えると、再読み込みで別のページが開く。
	const [listed, setListed] = useState(info.unlisted !== true);
	useEffect(() => {
		if (!listed) return;
		// URLを、ページのいまの名前に合わせる。再読み込みしても、共有しても、同じページが開く。
		const target = new URL(pageHref(named.title), window.location.href);
		if (target.pathname !== window.location.pathname || target.search !== window.location.search) {
			window.history.replaceState(window.history.state, "", target);
		}
	}, [named.title, listed]);
	// 端末内の記録に添える名前も、ページのいまの名前にする(ADR-0042)。
	useEffect(() => {
		if (!readOnly) pending.retitle(named.title);
	}, [pending, readOnly, named.title]);
	// 開いた名前と同じ名前で、別のページの変更が、この端末に残っているか(ADR-0042、Issue #18)。開いたときに1度だけ見る。
	const [strays] = useState<readonly PendingPageSummary[]>(() =>
		readOnly
			? []
			: strayPages(listPendingRecords(browserStorage()), {
					project: currentProject() ?? "",
					id: info.id,
					title: info.title,
				}),
	);
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
					setListed(true);
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
			// 読むだけの表示では、端末内の未送信の変更に触れない(前に書いて残したものを、消さない)。
			onPending: readOnly ? keepPending : pending.save,
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
	}, [snapshot, initial, placeholder, api, remote, pending, refreshLinks, readOnly]);

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
			{/* 本文の上の1段。左に、保存の状態と接続の状態。右に、ページの操作(ADR-0036)。 */}
			<div className="page-bar">
				{/* 削除されたことは、読むだけの表示でも伝える(本文は、最後の写しとして残っている)。 */}
				{readOnly && status !== "deleted" ? (
					<p className="page-status" role="status" data-status="read-only">
						読むだけの表示です。書き込めるのは、このプロジェクトのメンバーだけです
					</p>
				) : (
					<p className="page-status" role="status" data-status={status}>
						{STATUS_LABELS[status]}
					</p>
				)}
				{/* 保存の状態とは別に示す。切れていても、書いたものは端末内に残り、つながったら送られる。 */}
				<p className="page-connection" data-testid="connection" data-connection={connection}>
					{CONNECTION_LABELS[connection]}
				</p>
				{!readOnly && !WITHOUT_TOOLS.has(status) && (
					<PageTools id={info.id} pinned={pinned} onPinned={setPinned} />
				)}
			</div>
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
			{strays.length > 0 && (
				<div className="page-notice" role="note">
					「{info.title}
					」の名前で書いた、送れていない変更が、この端末に残っています。いまは別のページになっているので、ここには入っていません。
					<ul className="page-strays">
						{strays.map((stray) => (
							<li key={stray.id}>
								<a href={`./?page=${encodeURIComponent(stray.id)}`}>
									{formatSavedAt(stray.savedAt)}に残した変更のページを開く
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
			<Editor
				initialDocument={initial}
				remote={remote}
				onChange={handleChange}
				others={others}
				onCursor={handleCursor}
				missingLinks={missing}
				{...(readOnly ? { readOnly } : { completeTitles: searchTitles })}
			/>
			<RelatedPages links={links} />
		</>
	);
}
