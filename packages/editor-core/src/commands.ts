import { parseIndent } from "@amime/parser";
import { invariant } from "@amime/shared";
import type { EditorState } from "./types.ts";

/** カーソルのある行の本文を返す。カーソルが範囲外なら不変条件違反。 */
function currentLine(state: EditorState): string {
	const { line, column } = state.cursor;
	const text = state.lines[line];
	invariant(text !== undefined, `cursor line ${line} is out of range`);
	invariant(column >= 0 && column <= text.length, `cursor column ${column} is out of range`);
	return text;
}

/** カーソル位置に改行を含まない文字列を挿入する。 */
export function insertText(state: EditorState, text: string): EditorState {
	invariant(!text.includes("\n"), "insertText does not accept line breaks");
	const { line, column } = state.cursor;
	const current = currentLine(state);
	return {
		lines: state.lines.with(line, current.slice(0, column) + text + current.slice(column)),
		cursor: { line, column: column + text.length },
	};
}

/** カーソル位置で行を分割する。新しい行は、カーソルより前にあるインデントを引き継ぐ。 */
export function splitLine(state: EditorState): EditorState {
	const { line, column } = state.cursor;
	const current = currentLine(state);
	const head = current.slice(0, column);
	const inherited = head.slice(0, parseIndent(head).indent);
	return {
		lines: state.lines.toSpliced(line, 1, head, inherited + current.slice(column)),
		cursor: { line: line + 1, column: inherited.length },
	};
}
