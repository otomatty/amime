import { parseIndent } from "@amime/parser";
import { ceilToBoundary, nextBoundary, previousBoundary, snapToBoundary } from "./graphemes.ts";
import {
	type LineRange,
	lineAt,
	lineAtCursor,
	selectionRange,
	targetLines,
	withSelection,
} from "./state.ts";
import type { Cursor, EditorState } from "./types.ts";

const LINE_BREAK = /\r\n?/g;

/**
 * カーソル位置に文字列を挿入する。改行を含む場合は複数行として挿入する。
 * 範囲を選択しているときは、選択した範囲と置き換える。
 * 挿入する行のインデントには手を加えない(貼り付けた内容をそのまま保つ)。
 */
export function insertText(selected: EditorState, text: string): EditorState {
	lineAtCursor(selected);
	if (text === "") return selected;
	const state = cutSelection(selected);
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);

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

/**
 * カーソル位置で行を分割する。新しい行は、カーソルより前にあるインデントを引き継ぐ。
 * maxInherited を渡すと、引き継ぐインデントをその文字数までに限る
 * (テーブルの行で、インデントに続くセルの区切りのタブまで引き継がないようにする)。
 */
export function splitLine(
	selected: EditorState,
	maxInherited = Number.POSITIVE_INFINITY,
): EditorState {
	const state = cutSelection(selected);
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	const head = current.slice(0, column);
	const inherited = head.slice(0, Math.min(parseIndent(head).indent, maxInherited));
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

/**
 * 選択した範囲を取り除き、カーソルをその継ぎ目に置く。選択していなければ何もしない。
 * 継ぎ目の両側が1文字に結合しても、カーソルは寄せない。続けてその位置に文字を入れる操作
 * (置き換え、改行)のためのもので、寄せると入れる位置がずれてしまう。
 */
function cutSelection(state: EditorState): EditorState {
	const range = selectionRange(state);
	if (range === null) return state;
	const { start, end } = range;
	const head = lineAt(state.lines, start.line).slice(0, start.column);
	const tail = lineAt(state.lines, end.line).slice(end.column);
	return {
		lines: state.lines.toSpliced(start.line, end.line - start.line + 1, head + tail),
		cursor: start,
	};
}

/** 選択した範囲を消す。選択していなければ何もしない。 */
export function deleteSelection(state: EditorState): EditorState {
	const cut = cutSelection(state);
	if (cut === state) return state;
	// 消した継ぎ目の両側が1文字に結合することがある。その場合は、結合した文字の手前に置く。
	const { line, column } = cut.cursor;
	return {
		lines: cut.lines,
		cursor: { line, column: snapToBoundary(lineAt(cut.lines, line), column) },
	};
}

/** カーソルの直前の1文字を消す。行頭では前の行とつなげる。選択しているときは、選択した範囲だけを消す。 */
export function deleteBackward(state: EditorState): EditorState {
	if (selectionRange(state) !== null) return deleteSelection(state);
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

/** カーソルの直後の1文字を消す。行末では次の行とつなげる。選択しているときは、選択した範囲だけを消す。 */
export function deleteForward(state: EditorState): EditorState {
	if (selectionRange(state) !== null) return deleteSelection(state);
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

/**
 * 指定した範囲の行に shift を適用する。
 * カーソルと選択の始点は、moveColumn で行の動きに合わせてずらす。
 */
function shiftLines(
	state: EditorState,
	{ first, last }: LineRange,
	shift: (text: string) => string,
	moveColumn: (shifted: string, column: number) => number,
): EditorState {
	const lines = state.lines.map((text, index) =>
		index < first || index > last ? text : shift(text),
	);
	if (lines.every((text, index) => text === state.lines[index])) return state;

	const move = (position: Cursor): Cursor => {
		const shifted = lineAt(lines, position.line);
		if (shifted === state.lines[position.line]) return position;
		return { line: position.line, column: moveColumn(shifted, position.column) };
	};
	return withSelection(lines, move(state.cursor), state.anchor && move(state.anchor));
}

/** 指定した範囲の行を1段深くする。 */
export function indentLines(state: EditorState, range: LineRange): EditorState {
	return shiftLines(
		state,
		range,
		(text) => ` ${text}`,
		// 行頭が結合文字だと、足した空白と1文字に結合する。その場合は結合した文字の後ろに置く。
		(shifted, column) => ceilToBoundary(shifted, column + 1),
	);
}

/** 指定した範囲の行を1段浅くする。インデントのない行はそのまま。 */
export function outdentLines(state: EditorState, range: LineRange): EditorState {
	return shiftLines(
		state,
		range,
		(text) => (parseIndent(text).indent === 0 ? text : text.slice(1)),
		(shifted, column) => snapToBoundary(shifted, Math.max(0, column - 1)),
	);
}

/** カーソルのある行(選択しているときは、選択にかかるすべての行)を1段深くする。 */
export function indentLine(state: EditorState): EditorState {
	return indentLines(state, targetLines(state));
}

/** カーソルのある行(選択しているときは、選択にかかるすべての行)を1段浅くする。インデントのない行はそのまま。 */
export function outdentLine(state: EditorState): EditorState {
	return outdentLines(state, targetLines(state));
}
