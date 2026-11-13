import { titleOfLine } from "@amime/shared";
import type { PageCard, PageSort } from "@amime/sync";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { pageHref } from "../editor/links.ts";
import { listPages } from "../page/api.ts";
import { PageApiError } from "../page/page-api-error.ts";
import { PageCards } from "./page-card.tsx";
import "./page-list.css";

const SORT_LABELS: Readonly<Record<PageSort, string>> = {
	updated: "更新が新しい順",
	created: "作成が新しい順",
	title: "名前の順",
	linked: "リンクされている数が多い順",
};

// 定義した並び順だけを認める(in は、toString のような、どのオブジェクトにもある名前も通してしまう)。
const isSort = (value: string | null): value is PageSort =>
	value !== null && Object.hasOwn(SORT_LABELS, value);

/** URLに残してある並び順。なければ(知らない値でも)、更新が新しい順。 */
function sortFromUrl(): PageSort {
	const value = new URLSearchParams(window.location.search).get("sort");
	return isSort(value) ? value : "updated";
}

/** URLの中で、別の場所を指す書き方になる名前。ページの名前にできない(ADR-0024)。 */
const DOT_SEGMENTS: ReadonlySet<string> = new Set([".", ".."]);

type Loaded =
	| { readonly status: "loading" }
	| {
			readonly status: "ready";
			readonly pages: readonly PageCard[];
			/** サーバーから受け取った件数。続きは、この次から取り出す。 */
			readonly fetched: number;
			/** まだ取り出していないページがあるか。 */
			readonly more: boolean;
	  }
	| { readonly status: "error"; readonly kind: PageApiError["kind"] };

type PageListProps = {
	/** 別のページへ移る。テストで差し替える。 */
	readonly navigate?: (href: string) => void;
	/** 一覧を見る権限がないときに、代わりに表示する内容。 */
	readonly whenDisabled?: ReactNode;
	/** 読むだけにするか(メンバーでない人が、公開のプロジェクトを見ている)。新しいページを作る欄を出さない。 */
	readonly readOnly?: boolean;
};

/**
 * ページの一覧(ADR-0025)。保存されたページをカードとして並べ、並び順を選べる。
 * 名前を入れて、新しいページを書き始められる。
 */
export function PageList({
	navigate = (href) => window.location.assign(href),
	whenDisabled = null,
	readOnly = false,
}: PageListProps) {
	const [sort, setSort] = useState<PageSort>(sortFromUrl);
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [name, setName] = useState("");
	// 一覧を取り出し直すたびに進める。前の一覧の続きがあとから届いても、いまの一覧に混ぜない。
	const generation = useRef(0);
	// 続きを取り出しているあいだは、次の続きを取り出さない。同じ位置を2度取り出すと、続きの位置が進みすぎる。
	const paging = useRef(false);
	const [busy, setBusy] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt は、読み込みをやり直すためのきっかけとして使う。
	useEffect(() => {
		let cancelled = false;
		generation.current += 1;
		paging.current = false;
		setBusy(false);
		setLoaded({ status: "loading" });
		listPages({ sort, offset: 0 }).then(
			({ pages, total }) => {
				if (cancelled) return;
				setLoaded({ status: "ready", pages, fetched: pages.length, more: pages.length < total });
			},
			(error: unknown) => {
				const kind = error instanceof PageApiError ? error.kind : "failed";
				if (!cancelled) setLoaded({ status: "error", kind });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [sort, attempt]);

	const changeSort = (next: PageSort) => {
		setSort(next);
		// 選んだ並び順をURLに残す。再読み込みしても、共有しても、同じ並びになる。
		const url = new URL(window.location.href);
		url.searchParams.set("sort", next);
		window.history.replaceState(window.history.state, "", url);
	};

	const loadMore = useCallback(async () => {
		if (loaded.status !== "ready" || paging.current) return;
		const started = generation.current;
		paging.current = true;
		setBusy(true);
		const next = await listPages({ sort, offset: loaded.fetched }).catch(() => null);
		// 取り出しているあいだに、並び順を変えた(一覧を取り出し直した)。前の並び順の続きは捨てる。
		if (generation.current !== started) return;
		paging.current = false;
		setBusy(false);
		if (next === null) return;
		setLoaded((current) => {
			if (current.status !== "ready") return current;
			// 取り出しているあいだにページが増えると、続きが前の分と重なることがある。同じページは1度だけ並べる。
			const known = new Set(current.pages.map((page) => page.id));
			const added = next.pages.filter((page) => !known.has(page.id));
			// 続きの位置は、並べた件数ではなく、受け取った件数で数える。1件も返ってこなければ、そこで終わり。
			const fetched = current.fetched + next.pages.length;
			const more = next.pages.length > 0 && fetched < next.total;
			return { status: "ready", pages: [...current.pages, ...added], fetched, more };
		});
	}, [loaded, sort]);

	const create = (event: FormEvent) => {
		event.preventDefault();
		const title = titleOfLine(name);
		if (title === "" || DOT_SEGMENTS.has(title)) return;
		navigate(pageHref(title));
	};

	if (loaded.status === "error" && loaded.kind === "disabled") return whenDisabled;
	return (
		<section className="page-list" aria-label="ページの一覧">
			<div className="page-list-tools">
				{!readOnly && (
					<form className="new-page" onSubmit={create}>
						<label>
							新しいページの名前
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={200}
							/>
						</label>
						<button type="submit">作る</button>
					</form>
				)}
				<label className="page-sort">
					並び順
					<select
						value={sort}
						onChange={(event) => changeSort(isSort(event.target.value) ? event.target.value : sort)}
					>
						{Object.entries(SORT_LABELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
			</div>
			{loaded.status === "loading" && (
				<p className="page-status" role="status">
					読み込んでいます…
				</p>
			)}
			{loaded.status === "error" && (
				<p className="page-message">
					一覧を読み込めませんでした。
					<button type="button" onClick={() => setAttempt((count) => count + 1)}>
						もう一度読み込む
					</button>
				</p>
			)}
			{loaded.status === "ready" && loaded.pages.length === 0 && (
				<p className="page-message">
					まだページがありません。
					{!readOnly && "上の欄に名前を入れて、最初のページを作りましょう。"}
				</p>
			)}
			{loaded.status === "ready" && loaded.pages.length > 0 && <PageCards pages={loaded.pages} />}
			{loaded.status === "ready" && loaded.more && (
				<button className="page-list-more" type="button" disabled={busy} onClick={loadMore}>
					もっと見る
				</button>
			)}
		</section>
	);
}
