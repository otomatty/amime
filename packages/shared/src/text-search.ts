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
 * text の中で、語に合う範囲(元の文字列での位置)。前から順に、重なりはまとめる。
 * 照らし合わせるための形は、文字ごとに作る(元の文字列での位置に戻せるように)。
 */
function hitRanges(text: string, terms: readonly string[]): Range[] {
	// 照らし合わせるための形の、それぞれの位置が、元のどの文字(始まりと終わり)から来たか。
	const origins: Range[] = [];
	let folded = "";
	let position = 0;
	for (const character of text) {
		const origin = { start: position, end: position + character.length };
		const part = foldText(character);
		folded += part;
		for (let unit = 0; unit < part.length; unit += 1) origins.push(origin);
		position = origin.end;
	}

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
	const hit = hitRanges(line, terms)[0]?.start ?? 0;
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
