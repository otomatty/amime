import { setCursor } from "./motion.ts";
import { lineAt, selectionRange, withSelection } from "./state.ts";
import type { Cursor, EditorState } from "./types.ts";

/** 選択している文字列。行は改行でつなぐ。記法やインデントは、書いてあるとおりに含める。 */
export function selectedText(state: EditorState): string {
	const range = selectionRange(state);
	if (range === null) return "";
	const lastLine = lineAt(state.lines, range.end.line);
	const joined = state.lines.slice(range.start.line, range.end.line + 1).join("\n");
	return joined.slice(range.start.column, joined.length - (lastLine.length - range.end.column));
}

/** いまの始点(なければカーソル位置)を保ったまま、カーソルを cursor へ動かす。動かなければ同じ状態を返す。 */
function moveHead(state: EditorState, cursor: Cursor): EditorState {
	if (cursor.line === state.cursor.line && cursor.column === state.cursor.column) return state;
	return withSelection(state.lines, cursor, state.anchor ?? state.cursor);
}

/**
 * カーソルを動かす操作を、選択を広げる操作に変える(Shift+矢印など)。
 * 始点はそのままで、カーソルだけが動く。
 */
export function extendSelection(motion: (state: EditorState) => EditorState) {
	return (state: EditorState): EditorState => {
		// 選択を解除する動き(左右キーで選択の端へ飛ぶ)にならないよう、選択のない状態から動かす。
		const moved = motion({ lines: state.lines, cursor: state.cursor });
		return moveHead(state, moved.cursor);
	};
}

/** いまの始点(なければカーソル位置)から、指定した位置までを選択する(Shift+クリックやドラッグ)。 */
export function selectTo(state: EditorState, target: Cursor): EditorState {
	const moved = setCursor({ lines: state.lines, cursor: state.cursor }, target);
	return moveHead(state, moved.cursor);
}

/** 文書の先頭から末尾までを選択する。 */
export function selectAll(state: EditorState): EditorState {
	const lastLine = state.lines.length - 1;
	const end = { line: lastLine, column: lineAt(state.lines, lastLine).length };
	return withSelection(state.lines, end, { line: 0, column: 0 });
}
