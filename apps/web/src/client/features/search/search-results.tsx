import { highlight, textTerms } from "@amime/shared";
import type { SearchResults as Results } from "@amime/sync";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { pageHref } from "../editor/links.ts";
import { searchPages } from "../page/api.ts";
import { PageApiError } from "../page/page-api-error.ts";
import "./search-results.css";

const timeFormat = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });

type Loaded =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly results: Results }
	| { readonly status: "error" }
	| { readonly status: "disabled" };

type SearchResultsProps = {
	/** 探す語(空ではない)。 */
	readonly query: string;
	/** ページのAPIが無効な環境(公開環境)で、代わりに表示するもの。 */
	readonly whenDisabled?: ReactNode;
};

/** 語に合うところに印を付けた文字列。 */
function Marked({ text, terms }: { readonly text: string; readonly terms: readonly string[] }) {
	return highlight(text, terms).map((segment, index) =>
		segment.hit ? (
			// 分けた順は変わらない。同じ文字列もあるので、位置で識別する。
			// biome-ignore lint/suspicious/noArrayIndexKey: 上のとおり。
			<mark key={index}>{segment.text}</mark>
		) : (
			segment.text
		),
	);
}

/**
 * 本文を探した結果(ADR-0031)。見つかったページを、語を含む行と一緒に並べる。
 * 名前に語があるページが先、あとは更新が新しい順(並べるのはサーバー)。
 */
export function SearchResults({ query, whenDisabled = null }: SearchResultsProps) {
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const terms = useMemo(() => textTerms(query), [query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt は、探し直すためのきっかけとして使う。
	useEffect(() => {
		let cancelled = false;
		setLoaded({ status: "loading" });
		searchPages(query).then(
			(results) => {
				if (!cancelled) setLoaded({ status: "ready", results });
			},
			(error: unknown) => {
				if (cancelled) return;
				const disabled = error instanceof PageApiError && error.kind === "disabled";
				setLoaded({ status: disabled ? "disabled" : "error" });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [query, attempt]);

	if (loaded.status === "disabled") return whenDisabled;
	return (
		<section className="search-results" aria-labelledby="search-results-title">
			<h2 className="search-results-title" id="search-results-title">
				「{query}」を本文から探した結果
			</h2>
			{loaded.status === "loading" && (
				<p className="page-status" role="status">
					探しています…
				</p>
			)}
			{loaded.status === "error" && (
				<p className="page-message">
					探せませんでした。
					<button type="button" onClick={() => setAttempt((count) => count + 1)}>
						もう一度探す
					</button>
				</p>
			)}
			{loaded.status === "ready" && loaded.results.hits.length === 0 && (
				<p className="page-message">「{query}」を含むページはありません。</p>
			)}
			{loaded.status === "ready" && loaded.results.hits.length > 0 && (
				<ul className="search-hits">
					{loaded.results.hits.map((hit) => {
						const updated = new Date(hit.updated);
						return (
							<li className="search-hit" key={hit.id}>
								<h3 className="search-hit-title">
									<a href={pageHref(hit.title)}>
										<Marked text={hit.title} terms={terms} />
									</a>
								</h3>
								{hit.lines.map((line, index) => (
									// 添える行は、並びが変わらない。同じ行もあるので、位置で識別する。
									// biome-ignore lint/suspicious/noArrayIndexKey: 上のとおり。
									<p className="search-hit-line" key={index}>
										<Marked text={line} terms={terms} />
									</p>
								))}
								<time className="search-hit-time" dateTime={updated.toISOString()}>
									{timeFormat.format(updated)}
								</time>
							</li>
						);
					})}
				</ul>
			)}
			{loaded.status === "ready" && loaded.results.more && (
				<p className="page-message">ほかにも、合うページがあります。語を足すと、絞り込めます。</p>
			)}
		</section>
	);
}
