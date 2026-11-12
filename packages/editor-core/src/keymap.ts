import {
	deleteBackward,
	deleteForward,
	indentLine,
	insertText,
	outdentLine,
	splitLine,
} from "./commands.ts";
import type { EditGroup } from "./history.ts";
import { moveDown, moveLeft, moveRight, moveToLineEnd, moveToLineStart, moveUp } from "./motion.ts";
import { extendSelection, selectAll } from "./selection.ts";
import { selectionRange } from "./state.ts";
import type { EditorState } from "./types.ts";

/** キー入力のうち、割り当ての判断に使う情報。値は KeyboardEvent と同じ意味。 */
export type KeyInput = {
	readonly key: string;
	/** キーの位置(KeyboardEvent.code)。英字にならない配列で、ショートカットの英字を求めるのに使う。 */
	readonly code?: string;
	readonly shift: boolean;
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly meta: boolean;
};

/** エディタの状態を受け取り、操作後の状態を返す関数。 */
export type Command = (state: EditorState) => EditorState;

/** キーに割り当てられた働き。 */
export type KeyBinding =
	| {
			readonly type: "command";
			readonly command: Command;
			/** 続けて行ったときに1回の取り消しにまとめる編集の種類。まとめないなら null。 */
			readonly group: EditGroup | null;
	  }
	| { readonly type: "undo" }
	| { readonly type: "redo" };

/** キーの働きを変える状況。 */
export type KeyContext = {
	/**
	 * カーソルがテーブルの行にあるときの、その行のインデントの文字数。テーブルの行でなければ null。
	 * テーブルの行では、Tab がセルの区切り(タブ文字)の入力になり、
	 * Enter で引き継ぐインデントがこの文字数までになる。
	 */
	readonly tableRowIndent?: number | null;
	/** Mac かどうか。Mac では Command キー、それ以外では Ctrl キーとの組み合わせを使う。 */
	readonly mac?: boolean;
};

const run = (command: Command, group: EditGroup | null = null): KeyBinding => ({
	type: "command",
	command,
	group,
});

const UNDO: KeyBinding = { type: "undo" };
const REDO: KeyBinding = { type: "redo" };

const PLAIN_KEYS = new Map<string, KeyBinding>([
	["Enter", run(splitLine)],
	["Backspace", run(deleteBackward, "delete-backward")],
	["Delete", run(deleteForward, "delete-forward")],
	["ArrowLeft", run(moveLeft)],
	["ArrowRight", run(moveRight)],
	["ArrowUp", run(moveUp)],
	["ArrowDown", run(moveDown)],
	["Home", run(moveToLineStart)],
	["End", run(moveToLineEnd)],
	["Tab", run(indentLine)],
]);

const SHIFT_KEYS = new Map<string, KeyBinding>([
	["Enter", run(splitLine)],
	["Tab", run(outdentLine)],
	["ArrowLeft", run(extendSelection(moveLeft))],
	["ArrowRight", run(extendSelection(moveRight))],
	["ArrowUp", run(extendSelection(moveUp))],
	["ArrowDown", run(extendSelection(moveDown))],
	["Home", run(extendSelection(moveToLineStart))],
	["End", run(extendSelection(moveToLineEnd))],
]);

const LATIN_LETTER = /^[a-z]$/i;
const LETTER_KEY_CODE = /^Key([A-Z])$/;

/**
 * ショートカットの判定に使う英字(小文字)を返す。英字のキーでなければ null。
 * キーの文字が英字ならそれを使う。英字にならない配列(キリル文字など)では、
 * キーの位置から英字を求める。Ctrl+Z などが、配列を切り替えなくても働く。
 */
export function shortcutLetter(input: KeyInput): string | null {
	if (LATIN_LETTER.test(input.key)) return input.key.toLowerCase();
	return LETTER_KEY_CODE.exec(input.code ?? "")?.[1]?.toLowerCase() ?? null;
}

/** Ctrl(Mac では Command)との組み合わせ。コピー・切り取り・貼り付けは、ここでは扱わずブラウザに任せる。 */
function modifiedBinding(input: KeyInput, mac: boolean): KeyBinding | null {
	const key = shortcutLetter(input);
	if (key === "z") return input.shift ? REDO : UNDO;
	if (input.shift) return null;
	if (key === "y" && !mac) return REDO;
	if (key === "a") return run(selectAll);
	return null;
}

/**
 * テーブルの行での Tab。選択していなければ、セルの区切り(タブ文字)を入れる。
 * 選択しているときは、ほかの行と同じく選択した行のインデントにする(選択した文字をタブで置き換えない)。
 */
const tabInTableRow: Command = (state) =>
	selectionRange(state) === null ? insertText(state, "\t") : indentLine(state);

/** テーブルの行の中でだけ働きが変わるキー。 */
function tableRowBinding(input: KeyInput, tableRowIndent: number): KeyBinding | null {
	if (input.key === "Tab" && !input.shift) return run(tabInTableRow);
	if (input.key === "Enter") return run((state) => splitLine(state, tableRowIndent));
	return null;
}

/**
 * キー入力に割り当てられた働きを返す。
 * 割り当てがなければ null を返す(呼び出し側はブラウザの既定の動作に任せる)。
 */
export function bindingForKey(input: KeyInput, context: KeyContext = {}): KeyBinding | null {
	const mac = context.mac ?? false;
	const modifier = mac ? input.meta : input.ctrl;
	const otherModifier = mac ? input.ctrl : input.meta;
	if (input.alt || otherModifier) return null;
	if (modifier) return modifiedBinding(input, mac);

	const tableRowIndent = context.tableRowIndent ?? null;
	const inTable = tableRowIndent === null ? null : tableRowBinding(input, tableRowIndent);
	return inTable ?? (input.shift ? SHIFT_KEYS : PLAIN_KEYS).get(input.key) ?? null;
}
