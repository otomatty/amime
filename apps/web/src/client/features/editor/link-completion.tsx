import { canCompleteLink, type LinkQuery, linkQueryAt } from "@amime/editor-core";
import type { LineRole } from "@amime/parser";
import { type Ref, useEffect, useMemo, useState } from "react";

/** 入力が止まってから、候補を探し始めるまでの時間。打つたびに問い合わせない。 */
const SEARCH_DELAY_MS = 100;

/** 開いている候補。 */
type Completion = {
	/** 書いている途中のリンク。 */
	readonly link: LinkQuery;
	readonly titles: readonly string[];
	/** 選んでいる候補の番号。どれも選んでいなければ -1。 */
	readonly active: number;
};

type CompletionOptions = {
	/**
	 * カーソルのある行の本文。補完の対象にしないとき(フォーカスがない、変換中、範囲を選択している、
	 * コードの行など)は null。
	 */
	readonly text: string | null;
	/** カーソルの、行の中の位置。 */
	readonly column: number;
	/** カーソルのある行を区別する値(行ID)。 */
	readonly line: string | null;
	/** ページの中での、カーソルのある行の役割(本文、テーブルの行、など)。記法の読み方が変わる。 */
	readonly role: LineRole | undefined;
	/** 名前の一部から、候補を探す。渡さなければ、補完しない。 */
	readonly search: ((query: string) => Promise<readonly string[]>) | undefined;
};

/**
 * リンクを書いている途中の、名前の候補(ADR-0030)。
 * 候補は、最初はどれも選んでいない(Enter を、改行のために使えるように)。上下に動かすと選ぶ。
 */
export function useLinkCompletion({ text, column, line, role, search }: CompletionOptions) {
	const link = useMemo(
		() => (text === null || search === undefined ? null : linkQueryAt(text, column, role)),
		[text, column, role, search],
	);
	// どのリンクか(行と、名前の始まりの位置)。
	const anchor = link === null ? null : `${line}:${link.start}`;
	const query = link?.query ?? null;
	// 見つかった候補と、それが、どのリンクの、どの入力への候補か。
	const [found, setFound] = useState<{
		readonly anchor: string;
		readonly query: string;
		readonly titles: readonly string[];
	} | null>(null);
	// 選んでいる候補の名前。番号ではなく名前で覚える(候補の並びが変わっても、別の名前を選んだことにならない)。
	const [picked, setPicked] = useState<string | null>(null);
	// リンクから離れたり、入力が変わったりしたら、選んでいた候補を外す。
	// 戻ってきたときに、前の選択が残っていると、Enter で意図しない補完をしてしまう。
	// biome-ignore lint/correctness/useExhaustiveDependencies: anchor と query は、外すきっかけとして使う。
	useEffect(() => setPicked(null), [anchor, query]);
	// 候補を閉じたリンク。同じリンクを書いているあいだは、候補を出さない。
	const [dismissed, setDismissed] = useState<string | null>(null);
	// そのリンクから離れたら(消した、別のリンクへ移った)、閉じたことを忘れる。
	// 同じ位置に新しく書いたリンクには、また候補を出す。
	useEffect(() => {
		if (dismissed !== null && dismissed !== anchor) setDismissed(null);
	}, [dismissed, anchor]);

	useEffect(() => {
		if (anchor === null || query === null || search === undefined) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			search(query).then(
				(titles) => {
					// 入力が進んだあとに届いた、前の入力への候補は使わない。
					if (cancelled) return;
					setFound({ anchor, query, titles });
					setPicked(null);
				},
				// 探せなくても、入力は続けられる。
				() => {},
			);
		}, SEARCH_DELAY_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [anchor, query, search]);

	const current =
		link !== null && found?.anchor === anchor && found.query === query && dismissed !== anchor;
	// その行に書いても、そのページへのリンクにならない名前(括弧を含む、など)は、候補に出さない。
	const titles = useMemo(
		() =>
			current && link !== null && text !== null
				? found.titles.filter((title) => canCompleteLink(text, link, title, role))
				: [],
		[current, found, link, text, role],
	);
	const active = picked === null ? -1 : titles.indexOf(picked);
	const completion: Completion | null =
		link === null || titles.length === 0 ? null : { link, titles, active };

	return {
		/** 開いている候補。開いていなければ null。 */
		completion,
		/** 選んでいる候補を、step だけ動かす。端まで行くと、反対の端に回る。 */
		move(step: 1 | -1): void {
			const count = titles.length;
			if (count === 0) return;
			// どれも選んでいないときは、下へ動かすと最初、上へ動かすと最後を選ぶ。
			const next = (Math.max(active, step === 1 ? -1 : 0) + step + count) % count;
			setPicked(titles[next] ?? null);
		},
		/** 候補を閉じる。同じリンクを書いているあいだは、もう出さない。 */
		dismiss(): void {
			setDismissed(anchor);
		},
	};
}

type CompletionListProps = {
	/** 一覧の id。候補の id は、これに番号を付けたもの。 */
	readonly id: string;
	readonly titles: readonly string[];
	/** 選んでいる候補の番号。どれも選んでいなければ -1。 */
	readonly active: number;
	/** 候補が押された。 */
	readonly onPick: (title: string) => void;
	readonly ref?: Ref<HTMLDivElement>;
};

/** 名前の候補の一覧。フォーカスは編集欄に置いたまま、選んでいる候補を示す。 */
export function CompletionList({ id, titles, active, onPick, ref }: CompletionListProps) {
	// 選んでいる候補を、一覧の見えるところに入れる。フォーカスは編集欄に置いたままなので、
	// ブラウザは、自動ではスクロールしない。
	useEffect(() => {
		if (active >= 0)
			document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [id, active]);
	return (
		<div className="completion" id={id} ref={ref} role="listbox" aria-label="ページの名前の候補">
			{titles.map((title, index) => (
				<div
					className="completion-option"
					id={`${id}-${index}`}
					key={title}
					role="option"
					aria-selected={index === active}
					// フォーカスは編集欄に置いたまま、選んでいる候補を aria-activedescendant で伝える。
					tabIndex={-1}
					onMouseDown={(event) => {
						// 編集欄からフォーカスを外さない。編集欄のカーソルも動かさない(押した位置へ移さない)。
						event.preventDefault();
						event.stopPropagation();
						onPick(title);
					}}
				>
					{title}
				</div>
			))}
		</div>
	);
}
