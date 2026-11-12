import type { SelectionRange } from "@amime/editor-core";

/** 1行の中で選択されている範囲。選択にかかっていなければ start と end は null。 */
export type LineSelection = {
	readonly start: number | null;
	readonly end: number | null;
	/** 選択がこの行の改行を越えて、次の行へ続いているか。 */
	readonly lineBreak: boolean;
};

const NONE: LineSelection = { start: null, end: null, lineBreak: false };

/** 文書全体の選択範囲から、指定した行(長さ length)の中で選択されている範囲を求める。 */
export function lineSelection(
	range: SelectionRange | null,
	line: number,
	length: number,
): LineSelection {
	if (range === null || line < range.start.line || line > range.end.line) return NONE;
	return {
		start: line === range.start.line ? range.start.column : 0,
		end: line === range.end.line ? range.end.column : length,
		lineBreak: line < range.end.line,
	};
}
