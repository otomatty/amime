import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { pageHref } from "../editor/links.ts";
import { searchTitles } from "../page/api.ts";
import { PageApiError } from "../page/page-api-error.ts";
import "./title-search.css";

/** 入力が止まってから、探し始めるまでの時間。打つたびに問い合わせない。 */
const SEARCH_DELAY_MS = 150;
/** 日本語入力の変換中に届くキーの keyCode。 */
const KEY_CODE_COMPOSING = 229;

type TitleSearchProps = {
	/** 別のページへ移る。テストで差し替える。 */
	readonly navigate?: (href: string) => void;
};

type Found = {
	/** 何を入力したときの候補か。 */
	readonly query: string;
	readonly titles: readonly string[];
};

/**
 * 名前でページを探す欄(ADR-0029)。入力するたびに、合う名前の候補を出す。
 * 候補は、上下の矢印キーで選び、Enter で開く。何も入力していないときは、最近更新したページを候補にする。
 * ページのAPIが無効な環境では、何も出さない。
 */
export function TitleSearch({
	navigate = (href) => window.location.assign(href),
}: TitleSearchProps) {
	const [query, setQuery] = useState("");
	// 探す欄を出すか。ページのAPIが使えると分かるまでは、出さない。
	const [available, setAvailable] = useState(false);
	const [found, setFound] = useState<Found>({ query: "", titles: [] });
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const listId = useId();
	// 探し直すたびに進める。あとから届いた前の入力への応答で、いまの候補を上書きしない。
	const latest = useRef(0);

	useEffect(() => {
		latest.current += 1;
		const started = latest.current;
		const search = () =>
			searchTitles(query).then(
				(titles) => {
					if (latest.current !== started) return;
					setAvailable(true);
					setFound({ query, titles });
					setActive(0);
				},
				(error: unknown) => {
					// 無効な環境でなければ、欄は出す。探すのに失敗しただけなら、次の入力でまた探す。
					if (!(error instanceof PageApiError && error.kind === "disabled")) setAvailable(true);
				},
			);
		// 最初(何も入力していないとき)は、待たずに探す。ページのAPIが使えるかも、ここで分かる。
		const timer = setTimeout(search, query === "" ? 0 : SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [query]);

	// 矢印キーで選んだ候補を、候補の一覧の見えるところに入れる。フォーカスは欄に置いたままなので、
	// ブラウザは、自動ではスクロールしない。
	useEffect(() => {
		if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [open, active, listId]);

	if (!available) return null;

	// いまの入力への候補だけを見せる(前の入力への候補を、いまの入力の候補として見せない)。
	const titles = found.query === query ? found.titles : [];
	const shown = open && titles.length > 0;
	const empty = open && query !== "" && found.query === query && titles.length === 0;
	const optionId = (index: number) => `${listId}-${index}`;
	const go = (title: string | undefined) => {
		if (title !== undefined) navigate(pageHref(title));
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		// 日本語入力の変換を確定する Enter や、候補を選ぶ矢印キーは、入力のための操作。
		if (event.nativeEvent.isComposing || event.keyCode === KEY_CODE_COMPOSING) return;
		if (event.key === "Escape") {
			setOpen(false);
			return;
		}
		if (!shown) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((current) => (current + step + titles.length) % titles.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			go(titles[active]);
		}
	};

	return (
		<div className="title-search">
			<input
				className="title-search-input"
				type="search"
				role="combobox"
				aria-label="ページを探す"
				aria-expanded={shown}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={shown ? optionId(active) : undefined}
				placeholder="ページを探す"
				autoComplete="off"
				value={query}
				onChange={(event) => {
					setQuery(event.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onKeyDown={handleKeyDown}
			/>
			<div
				className="title-search-list"
				id={listId}
				role="listbox"
				aria-label="ページの候補"
				hidden={!shown}
			>
				{shown &&
					titles.map((title, index) => (
						<div
							className="title-search-option"
							id={optionId(index)}
							key={title}
							role="option"
							aria-selected={index === active}
							// フォーカスは欄に置いたまま、選んでいる候補を aria-activedescendant で伝える。
							tabIndex={-1}
							// 押しても、欄からフォーカスを外さない(外れると、押し終える前に候補が閉じる)。
							onMouseDown={(event) => {
								event.preventDefault();
								go(title);
							}}
						>
							{title}
						</div>
					))}
			</div>
			{empty && (
				<p className="title-search-empty" role="status">
					合う名前のページはありません
				</p>
			)}
		</div>
	);
}
