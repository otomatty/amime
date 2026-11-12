import {
	deleteBackward,
	deleteForward,
	indentLine,
	insertText,
	outdentLine,
	splitLine,
} from "./commands.ts";
import type { EditGroup } from "./history.ts";
import {
	moveDown,
	moveLeft,
	moveRight,
	moveToDocumentEnd,
	moveToDocumentStart,
	moveToLineEnd,
	moveToLineStart,
	moveUp,
} from "./motion.ts";
import {
	indentBlock,
	moveBlockDown,
	moveBlockUp,
	moveLinesDown,
	moveLinesUp,
	outdentBlock,
} from "./outline.ts";
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
	/**
	 * Mac かどうか。取り消しや全選択、文書の端への移動には、Mac では Command キー、
	 * それ以外では Ctrl キーとの組み合わせを使う。行やかたまりを動かすキーは、どちらでも同じ。
	 */
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

/** Ctrl+矢印: 行だけを動かす。Mac でも Control キーを使う。 */
const LINE_KEYS = new Map<string, KeyBinding>([
	["ArrowUp", run(moveLinesUp)],
	["ArrowDown", run(moveLinesDown)],
	["ArrowLeft", run(outdentLine)],
	["ArrowRight", run(indentLine)],
]);

/** Alt(Mac では Option)+矢印: 行を子の行ごと動かす。 */
const BLOCK_KEYS = new Map<string, KeyBinding>([
	["ArrowUp", run(moveBlockUp)],
	["ArrowDown", run(moveBlockDown)],
	["ArrowLeft", run(outdentBlock)],
	["ArrowRight", run(indentBlock)],
]);

/** Mac の Option+左右は単語単位の移動に使われるので、割り当てない。 */
const MAC_WORD_KEYS = new Set(["ArrowLeft", "ArrowRight"]);

/** Ctrl との組み合わせでカーソルを動かすキー(Mac 以外)。 */
const CTRL_MOTIONS = new Map<string, Command>([
	["Home", moveToDocumentStart],
	["End", moveToDocumentEnd],
]);

/** Command との組み合わせでカーソルを動かすキー(Mac)。 */
const COMMAND_MOTIONS = new Map<string, Command>([
	["ArrowUp", moveToDocumentStart],
	["ArrowDown", moveToDocumentEnd],
	["ArrowLeft", moveToLineStart],
	["ArrowRight", moveToLineEnd],
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
	const motion = (mac ? COMMAND_MOTIONS : CTRL_MOTIONS).get(input.key);
	if (motion) return run(input.shift ? extendSelection(motion) : motion);

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

/** Ctrl・Alt・Meta のどれかを押しているときの割り当て。2つ以上を同時に押す組み合わせは扱わない。 */
function modifierBinding(input: KeyInput, mac: boolean): KeyBinding | null {
	const pressed = [input.ctrl, input.alt, input.meta].filter(Boolean).length;
	if (pressed > 1) return null;
	if (input.alt) return blockBinding(input, mac);
	const outline = input.ctrl && !input.shift ? LINE_KEYS.get(input.key) : undefined;
	if (outline) return outline;
	const primary = mac ? input.meta : input.ctrl;
	return primary ? modifiedBinding(input, mac) : null;
}

/** Alt(Mac では Option)との組み合わせ。 */
function blockBinding(input: KeyInput, mac: boolean): KeyBinding | null {
	if (input.shift || (mac && MAC_WORD_KEYS.has(input.key))) return null;
	return BLOCK_KEYS.get(input.key) ?? null;
}

/**
 * キー入力に割り当てられた働きを返す。
 * 割り当てがなければ null を返す(呼び出し側はブラウザの既定の動作に任せる)。
 */
export function bindingForKey(input: KeyInput, context: KeyContext = {}): KeyBinding | null {
	const mac = context.mac ?? false;
	if (input.alt || input.ctrl || input.meta) return modifierBinding(input, mac);

	const tableRowIndent = context.tableRowIndent ?? null;
	const inTable = tableRowIndent === null ? null : tableRowBinding(input, tableRowIndent);
	return inTable ?? (input.shift ? SHIFT_KEYS : PLAIN_KEYS).get(input.key) ?? null;
}
