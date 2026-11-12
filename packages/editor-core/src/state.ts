import { invariant } from "@amime/shared";
import type { Cursor, EditorState } from "./types.ts";

/** 指定した行の本文を返す。行が存在しなければ不変条件違反。 */
export function lineAt(lines: readonly string[], index: number): string {
	const text = lines[index];
	invariant(text !== undefined, `line ${index} is out of range`);
	return text;
}

/** カーソルのある行の本文を返す。カーソルが範囲外なら不変条件違反。 */
export function lineAtCursor(state: EditorState): string {
	const { line, column } = state.cursor;
	const text = lineAt(state.lines, line);
	invariant(column >= 0 && column <= text.length, `cursor column ${column} is out of range`);
	return text;
}

const isSamePosition = (a: Cursor, b: Cursor): boolean =>
	a.line === b.line && a.column === b.column;

const isBefore = (a: Cursor, b: Cursor): boolean =>
	a.line < b.line || (a.line === b.line && a.column < b.column);

/** 選択範囲。start が文書の前、end が後ろ。 */
export type SelectionRange = { readonly start: Cursor; readonly end: Cursor };

/** 選択範囲を、文書の前後の順に並べて返す。選択していなければ null。 */
export function selectionRange(state: EditorState): SelectionRange | null {
	const { anchor, cursor } = state;
	if (anchor === undefined || isSamePosition(anchor, cursor)) return null;
	return isBefore(anchor, cursor) ? { start: anchor, end: cursor } : { start: cursor, end: anchor };
}

/** 状態を組み立てる。anchor がないかカーソルと同じ位置なら、選択していない状態にする。 */
export function withSelection(
	lines: readonly string[],
	cursor: Cursor,
	anchor: Cursor | undefined,
): EditorState {
	if (anchor === undefined || isSamePosition(anchor, cursor)) return { lines, cursor };
	return { lines, cursor, anchor };
}
