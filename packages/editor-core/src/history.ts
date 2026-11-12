import type { EditorState } from "./types.ts";

/**
 * 1回の取り消しにまとめる編集の種類。
 * 同じ種類の編集が短い間隔で続いたら、まとめて1つの取り消しの単位にする。
 */
export type EditGroup = "typing" | "delete-backward" | "delete-forward";

/**
 * 取り消し・やり直しのための履歴。
 * 文書の状態をそのまま覚えておく方式。行の配列は編集のたびに新しく作られ、
 * 変わっていない行の文字列は共有されるので、覚えておく費用は行数ぶんの参照で済む。
 */
export type History = {
	/** 取り消すと戻る状態。古い順。 */
	readonly past: readonly EditorState[];
	readonly present: EditorState;
	/** やり直すと進む状態。近い順。 */
	readonly future: readonly EditorState[];
	/** 直前の編集の種類と時刻。次の編集を同じ単位にまとめるかどうかの判断に使う。 */
	readonly lastEdit: { readonly group: EditGroup; readonly at: number } | null;
};

/** 覚えておく取り消しの単位の数の上限。 */
export const MAX_HISTORY = 500;

/** 同じ種類の編集を1つの単位にまとめる、間隔の上限(ミリ秒)。 */
const MERGE_WINDOW_MS = 1000;

export function createHistory(present: EditorState): History {
	return { past: [], present, future: [], lastEdit: null };
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

	const merges =
		group !== null &&
		lastEdit !== null &&
		lastEdit.group === group &&
		at - lastEdit.at <= MERGE_WINDOW_MS;
	return {
		past: merges ? history.past : [...history.past, present].slice(-MAX_HISTORY),
		present: next,
		future: [],
		lastEdit: group === null ? null : { group, at },
	};
}

export function undo(history: History): History {
	const previous = history.past.at(-1);
	if (previous === undefined) return history;
	return {
		past: history.past.slice(0, -1),
		present: previous,
		future: [history.present, ...history.future],
		lastEdit: null,
	};
}

export function redo(history: History): History {
	const [next, ...future] = history.future;
	if (next === undefined) return history;
	return { past: [...history.past, history.present], present: next, future, lastEdit: null };
}
