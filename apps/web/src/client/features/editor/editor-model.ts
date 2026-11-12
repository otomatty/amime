import {
	applyEdit,
	type Command,
	createHistory,
	type EditGroup,
	type EditorState,
	type History,
	redo,
	selectTo,
	setCursor,
	undo,
} from "@amime/editor-core";
import {
	applyChanges,
	diffLines,
	type Line,
	type LineTracker,
	startTracking,
	trackLines,
} from "@amime/sync";

/** 編集欄の状態。編集の履歴と、行IDの割り当て。 */
export type EditorModel = {
	readonly history: History;
	readonly tracker: LineTracker;
};

/**
 * 外から届いた文書。他の人の変更を取り込んだ結果、画面の文書を置き換えるときに渡す。
 * base は、取り込みを計算した時点の画面の文書。そのあとに打った文字を載せ直すのに使う。
 */
export type RemoteDocument = {
	readonly lines: readonly Line[];
	readonly base: readonly Line[];
};

export type EditorAction =
	| {
			readonly type: "edit";
			readonly command: Command;
			/** 続けて行ったときに1回の取り消しにまとめる編集の種類。 */
			readonly group: EditGroup | null;
			/** 操作した時刻。reducer を純粋に保つため、呼び出し側で測って渡す。 */
			readonly at: number;
	  }
	| { readonly type: "undo" }
	| { readonly type: "redo" }
	| ({ readonly type: "replace" } & RemoteDocument);

type InitialContent = {
	/** 行IDを持たない最初の本文。 */
	readonly initialLines?: readonly string[] | undefined;
	/** 行IDを持つ最初の文書。行があれば、こちらを使う。 */
	readonly initialDocument?: readonly Line[] | undefined;
};

/** この端末が作る行IDの接頭辞。編集欄ごとに違う値にして、他の人や他のタブが作るIDと重ならないようにする。 */
export const createIdPrefix = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

const START: EditorState["cursor"] = { line: 0, column: 0 };
const textsOf = (lines: readonly Line[]): string[] => lines.map((line) => line.text);

/**
 * 行を持つ追跡の状態から、編集欄の状態を作る。カーソルと選択の始点は、行の範囲に収める。
 * anchor を渡すと、そこからカーソルまでを選択した状態にする。
 */
function modelOf(
	tracker: LineTracker,
	cursor: EditorState["cursor"],
	anchor: EditorState["cursor"] | null = null,
): EditorModel {
	const start: EditorState = { lines: textsOf(tracker.lines), cursor: START };
	const state =
		anchor === null ? setCursor(start, cursor) : selectTo(setCursor(start, anchor), cursor);
	return { history: createHistory(state), tracker };
}

/**
 * 編集欄の最初の状態を作る。編集欄は常に1行以上を持つ。
 * prefix は、この端末が作る行IDの接頭辞。
 */
export function createModel(content: InitialContent, prefix: string): EditorModel {
	const { initialDocument = [], initialLines = [] } = content;
	if (initialDocument.length > 0) {
		return modelOf({ lines: initialDocument, prefix, serial: 0 }, START);
	}
	return modelOf(startTracking(initialLines.length > 0 ? initialLines : [""], prefix), START);
}

function nextHistory(history: History, action: Exclude<EditorAction, { type: "replace" }>) {
	switch (action.type) {
		case "edit":
			return applyEdit(history, action.command, action);
		case "undo":
			return undo(history);
		case "redo":
			return redo(history);
	}
}

/**
 * 画面の文書を、外から届いた文書に置き換える。
 * カーソルと選択は同じ行についていく。履歴は捨てる(取り消しで他の人の変更を巻き戻さないため。ADR-0014)。
 */
function replaceDocument(model: EditorModel, remote: RemoteDocument): EditorModel {
	const current = model.tracker.lines;
	// 取り込みの計算のあとに打った文字があれば、届いた文書に載せ直す。
	const lines =
		current === remote.base
			? remote.lines
			: applyChanges(remote.lines, diffLines(remote.base, current)).lines;
	const tracker = { ...model.tracker, lines };

	/** 位置を、同じ行の新しい位置にする。その行がなくなっていたら null。 */
	const follow = (position: EditorState["cursor"]): EditorState["cursor"] | null => {
		const index = lines.findIndex((line) => line.id === current[position.line]?.id);
		return index === -1 ? null : { line: index, column: position.column };
	};
	const { cursor, anchor } = model.history.present;
	return modelOf(
		// すべての行が消されていたら、空の1行を置く。
		lines.length > 0 ? tracker : trackLines(tracker, [""]),
		// カーソルのある行が消されていたら、同じ位置にある行へ移る。
		follow(cursor) ?? cursor,
		// 選択の始点の行が消されていたら、選択をやめる。
		anchor ? follow(anchor) : null,
	);
}

export function reduceModel(model: EditorModel, action: EditorAction): EditorModel {
	if (action.type === "replace") return replaceDocument(model, action);
	const history = nextHistory(model.history, action);
	if (history === model.history) return model;
	// 行IDは、編集の前後の本文を見比べて割り当てる。編集の操作そのものは本文だけを扱う(ADR-0016)。
	return { history, tracker: trackLines(model.tracker, history.present.lines) };
}
