import { itemAt } from "./item-at.ts";

/** 探した結果に見せる、行の切り出しの長さ(UTF-16 の符号単位)。 */
export const SNIPPET_LENGTH = 120;
/** 行を切り出すとき、語の前に残す長さ。 */
const SNIPPET_LEAD = 30;

/**
 * 照らし合わせるための形にする。大文字と小文字、全角と半角の違いをなくす
 * (Unicode の互換の正規化 NFKC と、小文字へのそろえ)。
 */
export function foldText(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

/**
 * 入力を、本文を探すための語に分ける。空白で区切り、照らし合わせるための形にする。同じ語は、1つにまとめる。
 * 語の数や長さで、入力を切り捨てない(切り捨てると、合わないページが見つかったことになる)。
 */
export function textTerms(query: string): string[] {
	const terms = foldText(query)
		.split(/\s+/)
		.filter((term) => term !== "");
	return [...new Set(terms)];
}

type Range = { readonly start: number; readonly end: number };

/**
 * 前の文字に付く記号(濁点、アクセントなど)。すぐ前の文字とは合わさらなくても、
 * その前の文字と合わさることがあるので、いつも前の文字と同じまとまりに入れる。
 */
const MARK = /^\p{M}/u;
/**
 * ひとまとまりにする長さの上限(UTF-16 の符号単位)。合わさる文字がとても長く続いても、
 * まとまりを作り直す手間を、行の長さに比例する量に抑える。ふつうの文章では、届かない長さ。
 */
const MAX_PIECE = 64;

/**
 * 照らし合わせるための形と、そのそれぞれの位置が、元の文字列のどの範囲から来たか。
 * 前の文字と合わさって1つの形になる文字(濁点が別の文字になっている半角カナ、あとに付く濁点など)は、
 * 前の文字と同じ範囲にまとめる(文字列の全体を照らし合わせるための形にしたものと、同じ結果にする)。
 */
function foldWithOrigins(text: string): { folded: string; origins: Range[] } {
	const origins: Range[] = [];
	let folded = "";
	// いま集めている、ひとまとまり(元の文字列)と、その照らし合わせるための形。
	let piece = "";
	let pieceFolded = "";
	let start = 0;
	let position = 0;
	const close = () => {
		const origin = { start, end: position };
		for (let unit = 0; unit < pieceFolded.length; unit += 1) origins.push(origin);
		folded += pieceFolded;
	};
	for (const character of text) {
		const joined = foldText(piece + character);
		const alone = foldText(character);
		const joins = MARK.test(character) || joined !== pieceFolded + alone;
		if (!joins || piece.length >= MAX_PIECE) {
			// 前の文字とは、合わさらない(または、まとまりが長くなりすぎた)。ここから、新しいまとまりにする。
			close();
			start = position;
			piece = character;
			pieceFolded = alone;
		} else {
			piece += character;
			pieceFolded = joined;
		}
		position += character.length;
	}
	close();
	return { folded, origins };
}

/** text の中で、語に合う範囲(元の文字列での位置)。前から順に、重なりはまとめる。 */
function hitRanges(text: string, terms: readonly string[]): Range[] {
	const { folded, origins } = foldWithOrigins(text);

	const ranges: Range[] = [];
	for (const term of terms) {
		for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
			ranges.push({
				start: itemAt(origins, at).start,
				end: itemAt(origins, at + term.length - 1).end,
			});
		}
	}
	ranges.sort((a, b) => a.start - b.start);

	const merged: Range[] = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous !== undefined && range.start <= previous.end) {
			merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
		} else {
			merged.push(range);
		}
	}
	return merged;
}

/**
 * text の中で、最初に語に合う位置(元の文字列での位置)。どこにも合わなければ、先頭(0)。
 * 合う場所のすべては求めない(長い行に、語がとても多くの場所で合うことがある)。
 */
function firstHit(text: string, terms: readonly string[]): number {
	const { folded, origins } = foldWithOrigins(text);
	const found = terms.map((term) => folded.indexOf(term)).filter((at) => at !== -1);
	return found.length === 0 ? 0 : itemAt(origins, Math.min(...found)).start;
}

/**
 * 文字列の両端に、組の片方だけになった文字(サロゲート)があれば、取り除く。
 * 2つの符号単位で表す文字の途中で切ると、先頭に後ろ半分が、末尾に前半分が残る。
 */
function wellFormed(text: string): string {
	const head = /^[\uDC00-\uDFFF]/.test(text) ? text.slice(1) : text;
	return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** 長い行を、最初に語に合うところのまわりだけにする。切ったところには「…」を付ける。 */
function clip(line: string, terms: readonly string[]): string {
	if (line.length <= SNIPPET_LENGTH) return line;
	const hit = firstHit(line, terms);
	const start = Math.max(Math.min(hit - SNIPPET_LEAD, line.length - SNIPPET_LENGTH), 0);
	const end = start + SNIPPET_LENGTH;
	const body = wellFormed(line.slice(start, end));
	return `${start > 0 ? "…" : ""}${body}${end < line.length ? "…" : ""}`;
}

/**
 * どれかの語を含む行を、出てくる順に、limit 行まで取り出す。前後の空白は取り除く。
 * 長い行は、語のまわりだけを切り出す。
 */
export function matchingLines(
	lines: readonly string[],
	terms: readonly string[],
	limit: number,
): string[] {
	return lines
		.map((line) => line.trim())
		.filter((line) => {
			const folded = foldText(line);
			return terms.some((term) => folded.includes(term));
		})
		.slice(0, limit)
		.map((line) => clip(line, terms));
}

/** 文字列の一部分。hit は、語に合うところか。 */
type Segment = { readonly text: string; readonly hit: boolean };

/**
 * 文字列を、語に合うところと、合わないところに分ける(合うところに印を付けて見せるため)。
 * 全角と半角、大文字と小文字の違いは区別しない。返す文字列は、元の文字のまま。
 */
export function highlight(text: string, terms: readonly string[]): Segment[] {
	const segments: Segment[] = [];
	let position = 0;
	for (const range of hitRanges(text, terms)) {
		if (range.start > position)
			segments.push({ text: text.slice(position, range.start), hit: false });
		segments.push({ text: text.slice(range.start, range.end), hit: true });
		position = range.end;
	}
	if (position < text.length) segments.push({ text: text.slice(position), hit: false });
	return segments;
}
