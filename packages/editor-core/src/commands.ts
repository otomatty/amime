import { parseIndent } from "@amime/parser";
import { nextBoundary, previousBoundary } from "./graphemes.ts";
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
	const lastLineStart = head.lastIndexOf("\n") + 1;
	return {
		lines: state.lines.toSpliced(line, 1, ...inserted),
		cursor: { line: line + inserted.length - 1, column: head.length - lastLineStart },
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

/** カーソルの直前の1文字を消す。行頭では前の行とつなげる。 */
export function deleteBackward(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (column > 0) {
		const start = previousBoundary(current, column);
		return {
			lines: state.lines.with(line, current.slice(0, start) + current.slice(column)),
			cursor: { line, column: start },
		};
	}

	const previous = state.lines[line - 1];
	if (previous === undefined) return state;
	return {
		lines: state.lines.toSpliced(line - 1, 2, previous + current),
		cursor: { line: line - 1, column: previous.length },
	};
}

/** カーソルの直後の1文字を消す。行末では次の行とつなげる。 */
export function deleteForward(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = lineAtCursor(state);
	if (column < current.length) {
		const end = nextBoundary(current, column);
		return {
			lines: state.lines.with(line, current.slice(0, column) + current.slice(end)),
			cursor: state.cursor,
		};
	}

	const next = state.lines[line + 1];
	if (next === undefined) return state;
	return {
		lines: state.lines.toSpliced(line, 2, current + next),
		cursor: state.cursor,
	};
}

/** カーソルのある行を1段深くする。 */
export function indentLine(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	return {
		lines: state.lines.with(line, ` ${lineAtCursor(state)}`),
		cursor: { line, column: column + 1 },
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
