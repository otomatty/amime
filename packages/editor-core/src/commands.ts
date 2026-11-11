import { parseIndent } from "@amime/parser";
import { ceilToBoundary, nextBoundary, previousBoundary, snapToBoundary } from "./graphemes.ts";
import { lineAtCursor } from "./state.ts";
import type { EditorState } from "./types.ts";

const LINE_BREAK = /\r\n?/g;

/**
 * カーソル位置に文字列を挿入する。改行を含む場合は複数行として挿入する。
 * 挿入する行のインデントには手を加えない(貼り付けた内容をそのまま保つ)。
 */
export function insertText(state: EditorState, text: string): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (text === "") return state;

	const head = current.slice(0, column) + text.replace(LINE_BREAK, "\n");
	const inserted = (head + current.slice(column)).split("\n");
	const lastLineHead = head.slice(head.lastIndexOf("\n") + 1);
	// 挿入した文字が後ろの文字と結合することがある(結合文字など)。その場合は結合した文字の後ろに置く。
	const lastColumn = ceilToBoundary(lastLineHead + current.slice(column), lastLineHead.length);
	return {
		lines: state.lines.toSpliced(line, 1, ...inserted),
		cursor: { line: line + inserted.length - 1, column: lastColumn },
	};
}

/** カーソル位置で行を分割する。新しい行は、カーソルより前にあるインデントを引き継ぐ。 */
export function splitLine(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	const head = current.slice(0, column);
	const inherited = head.slice(0, parseIndent(head).indent);
	return {
		lines: state.lines.toSpliced(line, 1, head, inherited + current.slice(column)),
		cursor: { line: line + 1, column: inherited.length },
	};
}

/**
 * 文字や改行を消したあとの行を組み立てる。
 * lines[first] から count 行を、head + tail の1行に置き換え、カーソルを継ぎ目に置く。
 * 継ぎ目の両側が1文字に結合することがあるため(🇯 と 🇵 が国旗になるなど)、
 * その場合はカーソルを結合した文字の手前に寄せる。
 */
function removeBetween(
	state: EditorState,
	first: number,
	count: number,
	head: string,
	tail: string,
): EditorState {
	const joined = head + tail;
	return {
		lines: state.lines.toSpliced(first, count, joined),
		cursor: { line: first, column: snapToBoundary(joined, head.length) },
	};
}

/** カーソルの直前の1文字を消す。行頭では前の行とつなげる。 */
export function deleteBackward(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (column > 0) {
		const start = previousBoundary(current, column);
		return removeBetween(state, line, 1, current.slice(0, start), current.slice(column));
	}

	const previous = state.lines[line - 1];
	if (previous === undefined) return state;
	return removeBetween(state, line - 1, 2, previous, current);
}

/** カーソルの直後の1文字を消す。行末では次の行とつなげる。 */
export function deleteForward(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (column < current.length) {
		const end = nextBoundary(current, column);
		return removeBetween(state, line, 1, current.slice(0, column), current.slice(end));
	}

	const next = state.lines[line + 1];
	if (next === undefined) return state;
	return removeBetween(state, line, 2, current, next);
}

/** カーソルのある行を1段深くする。 */
export function indentLine(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const indented = ` ${lineAtCursor(state)}`;
	return {
		lines: state.lines.with(line, indented),
		// 行頭が結合文字だと、足した空白と1文字に結合する。その場合は結合した文字の後ろに置く。
		cursor: { line, column: ceilToBoundary(indented, column + 1) },
	};
}

/** カーソルのある行を1段浅くする。インデントがなければ何もしない。 */
export function outdentLine(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (parseIndent(current).indent === 0) return state;
	return {
		lines: state.lines.with(line, current.slice(1)),
		cursor: { line, column: Math.max(0, column - 1) },
	};
}
