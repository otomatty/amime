import { itemAt } from "@amime/shared";

/**
 * 1行の本文を、利用者から見た「1文字」(書記素)の単位で見比べる(ADR-0022)。
 * 絵文字や結合文字を途中で切らないために、文字の単位は Intl.Segmenter で決める。
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const graphemes = (text: string): string[] =>
	Array.from(segmenter.segment(text), ({ segment }) => segment);

/**
 * 見比べる範囲の大きさ(元の文字数 × 変えたあとの文字数)の上限。
 * これを超えたら、細かく見比べるのをやめて、範囲をまるごと置き換えたものとして扱う。
 * 見比べる手間と使うメモリが、この大きさに比例するため。
 */
const MAX_CELLS = 1_000_000;

/**
 * 元の本文を、変えたあとの本文にする手順。
 * - kept[i]: 元の i 文字目を残すか
 * - inserted[i]: 元の i 文字目の直前に足す文字(inserted[元の文字数] は、末尾に足す文字)
 */
type Script = {
	readonly kept: readonly boolean[];
	readonly inserted: readonly string[];
};

/** 2つの文字の列が、先頭から何文字同じか。 */
function commonPrefix(a: readonly string[], b: readonly string[]): number {
	const limit = Math.min(a.length, b.length);
	let length = 0;
	while (length < limit && a[length] === b[length]) length += 1;
	return length;
}

/** 2つの文字の列が、末尾から何文字同じか。先頭の skip 文字は数えない。 */
function commonSuffix(a: readonly string[], b: readonly string[], skip: number): number {
	const limit = Math.min(a.length, b.length) - skip;
	let length = 0;
	while (length < limit && a[a.length - 1 - length] === b[b.length - 1 - length]) length += 1;
	return length;
}

// biome-ignore lint/style/noNonNullAssertion: 表の範囲内だけを読む。見比べる文字の組ごとに呼ぶので、範囲の検査(itemAt)を省く。
const cell = (table: Uint16Array, index: number): number => table[index]!;

/**
 * a と b の、それぞれの位置から後ろについて、共通する文字を順に最も多く選んだときの数を求める。
 * 結果は (a.length + 1) × (b.length + 1) の表。[i * (b.length + 1) + j] が、a の i 文字目以降と b の j 文字目以降についての数。
 */
function commonLengths(a: readonly string[], b: readonly string[]): Uint16Array {
	const width = b.length + 1;
	const table = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		const row = i * width;
		for (let j = b.length - 1; j >= 0; j -= 1) {
			table[row + j] =
				a[i] === b[j]
					? cell(table, row + width + j + 1) + 1
					: Math.max(cell(table, row + width + j), cell(table, row + j + 1));
		}
	}
	return table;
}

/**
 * 統合に使える手間の残り。本文を見比べるたびに減らす(減らすのは、渡した側の値)。
 * 1度にたくさんの行を統合させて、処理を長引かせることができないようにする。
 * - chars: 見比べる本文の文字数。足りなければ、統合しない(あとから届いた本文にする)
 * - cells: 細かく見比べる範囲の大きさ。足りなければ、範囲をまるごと置き換えたものとして統合する(どちらの入力も残る)
 */
export type MergeBudget = { chars: number; cells: number };

/**
 * base を side にする手順を求める。残す文字ができるだけ多くなるようにする。
 * 文字を置き換えたところは、「消した文字の並びの直後に、足した文字がある」形にする。
 *
 * 細かく見比べるのは、変わった範囲の大きさが limit 以下のときだけ。超えたら、範囲をまるごと置き換えたものとして扱う。
 * 返す cells は、細かく見比べた範囲の大きさ。
 */
function editScript(
	base: readonly string[],
	side: readonly string[],
	limit: number,
): Script & { readonly cells: number } {
	const kept = base.map(() => true);
	const inserted = Array.from({ length: base.length + 1 }, () => "");

	// 前後の同じ部分は、そのまま残す。ふつうの入力では、変わるのは1か所だけなので、ここでほとんどが決まる。
	const prefix = commonPrefix(base, side);
	const suffix = commonSuffix(base, side, prefix);
	const a = base.slice(prefix, base.length - suffix);
	const b = side.slice(prefix, side.length - suffix);

	const cells = a.length * b.length;
	if (cells > limit) {
		a.forEach((_, index) => {
			kept[prefix + index] = false;
		});
		inserted[prefix + a.length] = b.join("");
		return { kept, inserted, cells: 0 };
	}

	const width = b.length + 1;
	const table = commonLengths(a, b);
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i += 1;
			j += 1;
		} else if (cell(table, (i + 1) * width + j) >= cell(table, i * width + j + 1)) {
			kept[prefix + i] = false;
			i += 1;
		} else {
			inserted[prefix + i] += itemAt(b, j);
			j += 1;
		}
	}
	for (; i < a.length; i += 1) kept[prefix + i] = false;
	inserted[prefix + i] += b.slice(j).join("");
	return { kept, inserted, cells };
}

/**
 * incoming が文字を置き換えたところ(消した文字の並びの直後に、足した文字がある)の様子。
 * - length: 直前に並んでいる、incoming が消した文字の数。0 なら、置き換えではない
 * - gone: その文字を、current もすべて消しているか
 */
type Replaced = { readonly length: number; readonly gone: boolean };

const NOT_REPLACED: Replaced = { length: 0, gone: true };

/** index 文字目の直前に、両方が足した文字を合わせたもの。 */
function insertedAt(
	ours: Script,
	theirs: Script,
	index: number,
	replaced: Replaced,
	mode: "both" | "yield",
): string {
	const first = itemAt(ours.inserted, index);
	const yielded = mode === "yield" && replaced.length > 0 && replaced.gone;
	const second = yielded ? "" : itemAt(theirs.inserted, index);
	if (first === second) return first;
	// incoming が置き換えた語の直後に、current が足した文字。置き換えた語を前にする。
	if (replaced.length > 0 && ours.kept[index - 1] === true) return second + first;
	return first + second;
}

type MergeOptions = {
	/**
	 * - both(既定): どちらが足した文字も残す。
	 * - yield: incoming が文字を置き換えようとしたところで、置き換える文字を current がすべて消していたら、置き換えない。
	 *   自分の編集を打ち消すときに使う(他の人が書き換えたところに、古い文字を戻さない)。
	 */
	readonly mode?: "both" | "yield";
	/** 使える手間の残り。なければ、制限しない(1回の見比べの上限だけがかかる)。 */
	readonly budget?: MergeBudget;
};

/**
 * 同じ本文(base)から別々に書き換えた2つの本文を、文字単位で統合する。
 * current は先に入っていた本文、incoming はあとから届いた本文。
 *
 * - どちらかが消した文字は、消える。
 * - どちらかが足した文字は、残る。
 * - 両方が同じ場所に足していたら、先に入っていたほう(current)を前にして、どちらも残す。
 *   まったく同じ文字を足していたら、1度だけ足す。
 * - incoming が置き換えた語の直後に current が足していたら、置き換えた語を前にする(語のあとに足した文字が、語の前に来ないように)。
 *
 * 見比べる本文の量が、手間の残り(budget.chars)を超えるなら、統合せずに incoming を返す。
 */
export function mergeText(
	base: string,
	current: string,
	incoming: string,
	{ mode = "both", budget = { chars: Infinity, cells: Infinity } }: MergeOptions = {},
): string {
	if (current === base || current === incoming) return incoming;
	if (incoming === base) return current;

	const cost = base.length + current.length + incoming.length;
	if (cost > budget.chars) return incoming;
	budget.chars -= cost;

	const origin = graphemes(base);
	const ours = editScript(origin, graphemes(current), Math.min(MAX_CELLS, budget.cells));
	budget.cells -= ours.cells;
	const theirs = editScript(origin, graphemes(incoming), Math.min(MAX_CELLS, budget.cells));
	budget.cells -= theirs.cells;

	let merged = "";
	let replaced = NOT_REPLACED;
	for (let index = 0; index <= origin.length; index += 1) {
		merged += insertedAt(ours, theirs, index, replaced, mode);
		if (ours.kept[index] === true && theirs.kept[index] === true) merged += itemAt(origin, index);
		replaced =
			theirs.kept[index] === false
				? { length: replaced.length + 1, gone: replaced.gone && ours.kept[index] === false }
				: NOT_REPLACED;
	}
	return merged;
}

/**
 * before の中の位置(column)が、after の中のどこに当たるかを求める。位置は UTF-16 の単位で数える。
 * 本文が外から書き換えられたときに、カーソルを同じ文字のそばに保つために使う。
 *
 * - 手前に足された文字、手前で消された文字の分だけずれる。
 * - ちょうどその位置に足された文字があれば、その前にとどまる。
 * - その位置の文字が消されていたら、消された場所に寄る。
 */
export function mapColumn(before: string, after: string, column: number): number {
	if (before === after) return Math.min(column, after.length);

	const origin = graphemes(before);
	const { kept, inserted } = editScript(origin, graphemes(after), MAX_CELLS);
	let from = 0;
	let to = 0;
	for (const [index, grapheme] of origin.entries()) {
		if (column <= from) return to;
		to += itemAt(inserted, index).length;
		const end = from + grapheme.length;
		if (kept[index] === true) {
			// 文字の途中の位置は、その文字の中での位置を保つ。
			if (column < end) return to + (column - from);
			to += grapheme.length;
		} else if (column < end) {
			return to;
		}
		from = end;
	}
	return to;
}
