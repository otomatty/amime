import {
	deleteBackward,
	deleteForward,
	indentLine,
	insertText,
	outdentLine,
	splitLine,
} from "./commands.ts";
import { moveDown, moveLeft, moveRight, moveToLineEnd, moveToLineStart, moveUp } from "./motion.ts";
import type { EditorState } from "./types.ts";

/** キー入力のうち、割り当ての判断に使う情報。値は KeyboardEvent と同じ意味。 */
export type KeyInput = {
	readonly key: string;
	readonly shift: boolean;
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly meta: boolean;
};

/** エディタの状態を受け取り、操作後の状態を返す関数。 */
export type Command = (state: EditorState) => EditorState;

const PLAIN_KEYS = new Map<string, Command>([
	["Enter", splitLine],
	["Backspace", deleteBackward],
	["Delete", deleteForward],
	["ArrowLeft", moveLeft],
	["ArrowRight", moveRight],
	["ArrowUp", moveUp],
	["ArrowDown", moveDown],
	["Home", moveToLineStart],
	["End", moveToLineEnd],
	["Tab", indentLine],
]);

/** キーの働きを変える、カーソルのある行の状況。 */
export type KeyContext = {
	/** カーソルがテーブルの行にあるか。Tab がセルの区切り(タブ文字)の入力になる。 */
	readonly inTableRow: boolean;
};

const NO_CONTEXT: KeyContext = { inTableRow: false };

const insertTab: Command = (state) => insertText(state, "\t");

const SHIFT_KEYS = new Map<string, Command>([
	["Enter", splitLine],
	["Tab", outdentLine],
]);

/**
 * キー入力に割り当てられた操作を返す。
 * 割り当てがなければ null を返す(呼び出し側はブラウザの既定の動作に任せる)。
 */
export function commandForKey(input: KeyInput, context: KeyContext = NO_CONTEXT): Command | null {
	if (input.ctrl || input.alt || input.meta) return null;
	if (context.inTableRow && input.key === "Tab" && !input.shift) return insertTab;
	return (input.shift ? SHIFT_KEYS : PLAIN_KEYS).get(input.key) ?? null;
}
