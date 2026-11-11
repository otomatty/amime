import { invariant } from "@amime/shared";

/**
 * 利用者から見た「1文字」(書記素)を扱う。
 * 絵文字や結合文字は UTF-16 では複数単位になるため、カーソル移動と削除は必ずここを通す。
 * 位置(column)は UTF-16 の単位で数える。
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** index を含む文字を返す。index は 0 以上、text の長さ未満であること。 */
function graphemeAt(text: string, index: number): Intl.SegmentData {
	const found = segmenter.segment(text).containing(index);
	invariant(found !== undefined, `index ${index} is outside of the text`);
	return found;
}

export type Grapheme = {
	readonly text: string;
	/** この文字が始まる位置。 */
	readonly column: number;
};

export function segmentGraphemes(text: string): Grapheme[] {
	return Array.from(segmenter.segment(text), ({ segment, index }) => ({
		text: segment,
		column: index,
	}));
}

/** column の直前にある文字の開始位置。行頭では 0。 */
export function previousBoundary(text: string, column: number): number {
	if (column <= 0) return 0;
	return graphemeAt(text, column - 1).index;
}

/** column の直後にある文字の終了位置。行末では行の長さ。 */
export function nextBoundary(text: string, column: number): number {
	if (column >= text.length) return text.length;
	const { index, segment } = graphemeAt(text, column);
	return index + segment.length;
}

/** column を行の範囲に収め、文字の途中であればその文字の開始位置に寄せる。 */
export function snapToBoundary(text: string, column: number): number {
	if (column <= 0) return 0;
	if (column >= text.length) return text.length;
	return graphemeAt(text, column).index;
}

/** column を行の範囲に収め、文字の途中であればその文字の終了位置に寄せる。 */
export function ceilToBoundary(text: string, column: number): number {
	if (column <= 0) return 0;
	if (column >= text.length) return text.length;
	const start = graphemeAt(text, column).index;
	return start === column ? column : nextBoundary(text, start);
}
