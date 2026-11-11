import { invariant } from "@amime/shared";
import { nextBoundary, previousBoundary, snapToBoundary } from "./graphemes.ts";
import { lineAtCursor } from "./state.ts";
import type { Cursor, EditorState } from "./types.ts";

const withCursor = (state: EditorState, cursor: Cursor): EditorState => ({
	lines: state.lines,
	cursor,
});

/** 1文字左へ。行頭では前の行の末尾へ移る。 */
export function moveLeft(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (column > 0) return withCursor(state, { line, column: previousBoundary(current, column) });

	const previous = state.lines[line - 1];
	if (previous === undefined) return state;
	return withCursor(state, { line: line - 1, column: previous.length });
}

/** 1文字右へ。行末では次の行の先頭へ移る。 */
export function moveRight(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (column < current.length) {
		return withCursor(state, { line, column: nextBoundary(current, column) });
	}

	if (state.lines[line + 1] === undefined) return state;
	return withCursor(state, { line: line + 1, column: 0 });
}

/** 1行上へ。先頭の行では行頭へ移る。 */
export function moveUp(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const previous = state.lines[line - 1];
	if (previous === undefined) return withCursor(state, { line, column: 0 });
	return withCursor(state, { line: line - 1, column: snapToBoundary(previous, column) });
}

/** 1行下へ。最後の行では行末へ移る。 */
export function moveDown(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const next = state.lines[line + 1];
	if (next === undefined) return moveToLineEnd(state);
	return withCursor(state, { line: line + 1, column: snapToBoundary(next, column) });
}

export function moveToLineStart(state: EditorState): EditorState {
	return withCursor(state, { line: state.cursor.line, column: 0 });
}

export function moveToLineEnd(state: EditorState): EditorState {
	return withCursor(state, { line: state.cursor.line, column: lineAtCursor(state).length });
}

/** 指定した位置へカーソルを移す。範囲外や文字の途中の指定は、有効な位置に寄せる。 */
export function setCursor(state: EditorState, target: Cursor): EditorState {
	const line = Math.min(Math.max(target.line, 0), state.lines.length - 1);
	const text = state.lines[line];
	invariant(text !== undefined, "editor must have at least one line");
	return withCursor(state, { line, column: snapToBoundary(text, target.column) });
}
