import { itemAt } from "@amime/shared";
import {
	type Line,
	type LineId,
	type LineTracker,
	mapColumn,
	type OwnEdit,
	reapplyEdit,
	recordEdit,
	revertEdit,
	trackLines,
} from "@amime/sync";
import { setCursor } from "./motion.ts";
import { selectTo } from "./selection.ts";
import type { Cursor, EditorState } from "./types.ts";

/**
 * 1回の取り消しにまとめる編集の種類。
 * 同じ種類の編集が短い間隔で続いたら、まとめて1つの取り消しの単位にする。
 */
export type EditGroup = "typing" | "delete-backward" | "delete-forward";

/** 行IDで表した位置。行が増減したり動いたりしても、同じ行を指し続ける。 */
type Anchor = { readonly id: LineId; readonly column: number };
/** カーソルと選択の始点の位置。 */
type Position = { readonly cursor: Anchor; readonly anchor: Anchor | null };

/** 取り消しの1単位。自分が行った編集と、その前後のカーソルの位置。 */
type HistoryEntry = {
	readonly edit: OwnEdit;
	/** 編集の前の位置。取り消したときに戻す。 */
	readonly before: Position;
	/** 編集のあとの位置。やり直したときに戻す。 */
	readonly after: Position;
};

/**
 * 編集欄の文書と、取り消し・やり直しのための履歴(ADR-0019)。
 *
 * 履歴は、文書の状態ではなく「自分が行った編集」を行IDを対象にした変更として覚える。
 * 取り消しは、自分の編集だけを打ち消す。他の人の変更が届いても履歴は残り、取り消しても他の人の変更は巻き戻らない。
 */
export type History = {
	/** いまの状態(本文とカーソル)。 */
	readonly present: EditorState;
	/** 行IDつきの文書。本文の並びは、いつも present.lines と同じ。 */
	readonly tracker: LineTracker;
	/** 取り消せる編集。古い順。 */
	readonly past: readonly HistoryEntry[];
	/** やり直せる編集。近い順。 */
	readonly future: readonly HistoryEntry[];
	/**
	 * 直前の編集の種類と時刻、そのまとまりが始まる前の文書。
	 * 次の編集を同じ単位にまとめるかどうかの判断と、まとめた編集の記録に使う。
	 */
	readonly lastEdit: {
		readonly group: EditGroup;
		readonly at: number;
		readonly before: readonly Line[];
	} | null;
};

/** 覚えておく取り消しの単位の数の上限。 */
export const MAX_HISTORY = 500;

/** 同じ種類の編集を1つの単位にまとめる、間隔の上限(ミリ秒)。 */
const MERGE_WINDOW_MS = 1000;

const START: Cursor = { line: 0, column: 0 };

/** 編集欄は常に1行以上を持つ。行がなければ、空の1行を置く。 */
const withLine = (tracker: LineTracker): LineTracker =>
	tracker.lines.length > 0 ? tracker : trackLines(tracker, [""]);

/** 文書とカーソルの位置から、状態を作る。位置は、行の範囲と文字の区切りに収める。 */
function stateAt(lines: readonly Line[], cursor: Cursor, anchor: Cursor | null): EditorState {
	const start: EditorState = { lines: lines.map((line) => line.text), cursor: START };
	return anchor === null ? setCursor(start, cursor) : selectTo(setCursor(start, anchor), cursor);
}

/** いまのカーソルと選択の始点を、行IDで覚える。 */
function capture(state: EditorState, lines: readonly Line[]): Position {
	const anchorOf = (position: Cursor): Anchor => ({
		id: itemAt(lines, position.line).id,
		column: position.column,
	});
	return { cursor: anchorOf(state.cursor), anchor: state.anchor ? anchorOf(state.anchor) : null };
}

/**
 * 行IDで覚えた位置を、文書の上に戻す。
 * カーソルのあった行がなくなっていたら、fallback の位置(範囲に収める)にする。
 * 選択の始点の行がなくなっていたら、選択をやめる。
 */
function restore(lines: readonly Line[], position: Position, fallback: Cursor): EditorState {
	const locate = (anchor: Anchor): Cursor | null => {
		const line = lines.findIndex((current) => current.id === anchor.id);
		return line === -1 ? null : { line, column: anchor.column };
	};
	return stateAt(
		lines,
		locate(position.cursor) ?? fallback,
		position.anchor && locate(position.anchor),
	);
}

/** 行IDつきの文書から始める。 */
export function createHistory(tracker: LineTracker, cursor: Cursor = START): History {
	const started = withLine(tracker);
	return {
		present: stateAt(started.lines, cursor, null),
		tracker: started,
		past: [],
		future: [],
		lastEdit: null,
	};
}

type EditOptions = {
	/** まとめる編集の種類。null なら、必ず単独の取り消しの単位にする。 */
	readonly group: EditGroup | null;
	/** 編集した時刻(ミリ秒)。 */
	readonly at: number;
};

/**
 * 操作を実行し、文書が変わったら履歴に積む。
 * カーソルの移動や選択のように文書を変えない操作は、履歴に積まない。
 * 行IDは、編集の前後の本文を見比べて割り当てる(ADR-0016)。
 */
export function applyEdit(
	history: History,
	command: (state: EditorState) => EditorState,
	{ group, at }: EditOptions,
): History {
	const { present, lastEdit } = history;
	const next = command(present);
	if (next === present) return history;
	if (next.lines === present.lines) return { ...history, present: next, lastEdit: null };

	const tracker = trackLines(history.tracker, next.lines);
	const after = capture(next, tracker.lines);
	const merged =
		group !== null &&
		lastEdit !== null &&
		lastEdit.group === group &&
		at - lastEdit.at <= MERGE_WINDOW_MS
			? { before: lastEdit.before, entry: history.past.at(-1) }
			: null;
	// まとめるときは、まとまりが始まる前の文書からの編集として、最後の単位を記録し直す。
	const before = merged?.before ?? history.tracker.lines;
	const entry: HistoryEntry = {
		edit: recordEdit(before, tracker.lines),
		before: merged?.entry?.before ?? capture(present, history.tracker.lines),
		after,
	};
	const earlier = merged ? history.past.slice(0, -1) : history.past;
	return {
		present: next,
		tracker,
		past: [...earlier, entry].slice(-MAX_HISTORY),
		future: [],
		lastEdit: group === null ? null : { group, at, before },
	};
}

/**
 * 自分の編集を打ち消した(または、もう一度行った)あとの文書とカーソルを作る。
 * 文書が空になったら、空の1行を補う。
 */
function travel(history: History, lines: readonly Line[], position: Position) {
	const tracker = withLine({ ...history.tracker, lines });
	return { tracker, present: restore(tracker.lines, position, history.present.cursor) };
}

/**
 * 直前の自分の編集を取り消す。他の人の変更は巻き戻さない。
 * 取り消せなくなった編集(他の人が先に書き換えた、消した)は飛ばして、その前の編集を取り消す。
 *
 * やり直しのために覚えるのは、元の編集ではなく「この取り消しで実際に変わった分」。
 * 一部しか取り消せなかった編集をやり直したときに、取り消していない部分まで変えないためである。
 * 文書が空になって補った空の1行も、これに含まれる(やり直すと消える)。
 */
export function undo(history: History): History {
	const { past } = history;
	for (let index = past.length - 1; index >= 0; index -= 1) {
		const entry = itemAt(past, index);
		const lines = revertEdit(history.tracker.lines, entry.edit);
		if (lines === history.tracker.lines) continue;
		const next = travel(history, lines, entry.before);
		const undone = { ...entry, edit: recordEdit(next.tracker.lines, history.tracker.lines) };
		return {
			...next,
			past: past.slice(0, index),
			future: [undone, ...history.future],
			lastEdit: null,
		};
	}
	return past.length === 0 ? history : { ...history, past: [], lastEdit: null };
}

/**
 * 取り消した編集を、もう一度行う。やり直せなくなった編集は飛ばす。
 * 取り消しのために覚えるのは、このやり直しで実際に変わった分(undo と同じ理由)。
 */
export function redo(history: History): History {
	const { future } = history;
	for (const [index, entry] of future.entries()) {
		const lines = reapplyEdit(history.tracker.lines, entry.edit);
		if (lines === history.tracker.lines) continue;
		const next = travel(history, lines, entry.after);
		const redone = { ...entry, edit: recordEdit(history.tracker.lines, next.tracker.lines) };
		return {
			...next,
			past: [...history.past, redone],
			future: future.slice(index + 1),
			lastEdit: null,
		};
	}
	return future.length === 0 ? history : { ...history, future: [], lastEdit: null };
}

/**
 * 行の本文が書き換えられていたら、位置を、同じ文字のそばに移す(ADR-0022)。
 * 他の人がカーソルより前に文字を足したり消したりしても、カーソルが打っている場所からずれないようにする。
 */
function followText(before: readonly Line[], after: readonly Line[], anchor: Anchor): Anchor {
	const previous = before.find((line) => line.id === anchor.id);
	const next = after.find((line) => line.id === anchor.id);
	if (previous === undefined || next === undefined || previous.text === next.text) return anchor;
	return { id: anchor.id, column: mapColumn(previous.text, next.text, anchor.column) };
}

/**
 * 画面の文書を、外から届いた文書(他の人の変更を取り込んだもの)に置き換える。
 * カーソルと選択は、同じ行の、同じ文字のそばについていく。履歴はそのまま残る。
 * 続けて打っていた入力のまとまりは、ここで区切る(他の人の変更を、自分の編集に含めないため)。
 */
export function replaceLines(history: History, lines: readonly Line[]): History {
	const tracker = withLine({ ...history.tracker, lines });
	const captured = capture(history.present, history.tracker.lines);
	const follow = (anchor: Anchor): Anchor => followText(history.tracker.lines, lines, anchor);
	const position = {
		cursor: follow(captured.cursor),
		anchor: captured.anchor && follow(captured.anchor),
	};
	return {
		...history,
		present: restore(tracker.lines, position, history.present.cursor),
		tracker,
		lastEdit: null,
	};
}
