import { invariant } from "@amime/shared";
import type { EditorState } from "./types.ts";

/** カーソルのある行の本文を返す。カーソルが範囲外なら不変条件違反。 */
export function lineAtCursor(state: EditorState): string {
	const { line, column } = state.cursor;
	const text = state.lines[line];
	invariant(text !== undefined, `cursor line ${line} is out of range`);
	invariant(column >= 0 && column <= text.length, `cursor column ${column} is out of range`);
	return text;
}
