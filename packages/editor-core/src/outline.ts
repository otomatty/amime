import { parseIndent } from "@amime/parser";
import { indentLines, outdentLines } from "./commands.ts";
import { type LineRange, lineAt, targetLines, withSelection } from "./state.ts";
import type { Cursor, EditorState } from "./types.ts";

const indentOf = (text: string): number => parseIndent(text).indent;

/** 範囲の中でいちばん浅い行のインデント。 */
function baseIndent(lines: readonly string[], { first, last }: LineRange): number {
	return Math.min(...lines.slice(first, last + 1).map(indentOf));
}

/** from から下へ、indent より深い行が続くあいだ進み、その最後の行を返す。 */
function lastDeeper(lines: readonly string[], from: number, indent: number): number {
	let last = from;
	while (last + 1 < lines.length && indentOf(lineAt(lines, last + 1)) > indent) last += 1;
	return last;
}

/**
 * 対象の行に、その子の行(すぐ下に続く、より深い行)を加えた「かたまり」の範囲を返す。
 * 深さの基準は、対象の行のうちいちばん浅い行。
 */
function blockRange(state: EditorState): LineRange & { readonly indent: number } {
	const target = targetLines(state);
	const indent = baseIndent(state.lines, target);
	return { first: target.first, last: lastDeeper(state.lines, target.last, indent), indent };
}

/**
 * かたまりのすぐ上にある、入れ替える相手の最初の行を返す。上に行がなければ null。
 * 相手は、同じ深さの行とその子の行。すぐ上が浅い行(親の行)なら、その1行だけ。
 */
function unitAbove(lines: readonly string[], first: number, indent: number): number | null {
	if (first === 0) return null;
	let head = first - 1;
	while (head > 0 && indentOf(lineAt(lines, head)) > indent) {
		// 同じ深さの行がないまま浅い行に行き当たったら、深い行の並びだけを相手にする。
		if (indentOf(lineAt(lines, head - 1)) < indent) break;
		head -= 1;
	}
	return head;
}

/**
 * かたまりのすぐ下にある、入れ替える相手の最後の行を返す。下に行がなければ null。
 * 相手は、同じ深さの行とその子の行。すぐ下が浅い行なら、その1行だけ。
 */
function unitBelow(lines: readonly string[], last: number, indent: number): number | null {
	const next = lines[last + 1];
	if (next === undefined) return null;
	return indentOf(next) < indent ? last + 1 : lastDeeper(lines, last + 1, indent);
}

/**
 * first〜middle の行と、middle+1〜last の行を入れ替える。
 * カーソルと選択の始点は、対象の行(delta の符号で上下どちらかが決まる)と一緒に動かす。
 */
function swap(
	state: EditorState,
	first: number,
	middle: number,
	last: number,
	delta: number,
): EditorState {
	const { lines } = state;
	const swapped = [
		...lines.slice(0, first),
		...lines.slice(middle + 1, last + 1),
		...lines.slice(first, middle + 1),
		...lines.slice(last + 1),
	];
	const follow = (position: Cursor): Cursor => {
		const line = position.line + delta;
		// 行頭で終わる選択の終わりは、対象の行の直後にある。対象が文書の末尾へ動くと直後の行がなくなるので、末尾に置く。
		if (line === swapped.length)
			return { line: line - 1, column: lineAt(swapped, line - 1).length };
		return { line, column: position.column };
	};
	return withSelection(swapped, follow(state.cursor), state.anchor && follow(state.anchor));
}

function moveUp(state: EditorState, range: LineRange, head: number | null): EditorState {
	if (head === null) return state;
	return swap(state, head, range.first - 1, range.last, head - range.first);
}

function moveDown(state: EditorState, range: LineRange, tail: number | null): EditorState {
	if (tail === null) return state;
	return swap(state, range.first, range.last, tail, tail - range.last);
}

/** カーソルのある行(選択しているときは、選択にかかるすべての行)を、1行上へ動かす。子の行は動かさない。 */
export function moveLinesUp(state: EditorState): EditorState {
	const range = targetLines(state);
	return moveUp(state, range, range.first === 0 ? null : range.first - 1);
}

/** カーソルのある行(選択しているときは、選択にかかるすべての行)を、1行下へ動かす。子の行は動かさない。 */
export function moveLinesDown(state: EditorState): EditorState {
	const range = targetLines(state);
	return moveDown(state, range, range.last + 1 < state.lines.length ? range.last + 1 : null);
}

/** 行を子の行ごと、上にある同じ深さのかたまりと入れ替える。 */
export function moveBlockUp(state: EditorState): EditorState {
	const block = blockRange(state);
	return moveUp(state, block, unitAbove(state.lines, block.first, block.indent));
}

/** 行を子の行ごと、下にある同じ深さのかたまりと入れ替える。 */
export function moveBlockDown(state: EditorState): EditorState {
	const block = blockRange(state);
	return moveDown(state, block, unitBelow(state.lines, block.last, block.indent));
}

/** 行を子の行ごと、1段深くする。 */
export function indentBlock(state: EditorState): EditorState {
	return indentLines(state, blockRange(state));
}

/**
 * 行を子の行ごと、1段浅くする。
 * いちばん浅い行にインデントがなければ何もしない(子の行だけが浅くなり、親子の関係が崩れるのを避ける)。
 */
export function outdentBlock(state: EditorState): EditorState {
	const block = blockRange(state);
	return block.indent === 0 ? state : outdentLines(state, block);
}
