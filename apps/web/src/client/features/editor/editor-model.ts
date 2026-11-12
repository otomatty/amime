import {
	applyEdit,
	type Command,
	createHistory,
	type EditGroup,
	type History,
	redo,
	replaceLines,
	undo,
} from "@amime/editor-core";
import { type Line, startTracking } from "@amime/sync";

/**
 * 編集欄の状態。文書(本文、行ID、カーソル)と、取り消しのための履歴。
 * 規則はすべて @amime/editor-core にあり、ここは編集欄の操作をそれに取り次ぐだけ。
 */
export type EditorModel = History;

export type EditorAction =
	| {
			readonly type: "edit";
			readonly command: Command;
			/** 続けて行ったときに1回の取り消しにまとめる編集の種類。 */
			readonly group: EditGroup | null;
			/** 操作した時刻。状態の計算を純粋に保つため、呼び出し側で測って渡す。 */
			readonly at: number;
	  }
	| { readonly type: "undo" }
	| { readonly type: "redo" }
	/** 画面の文書を、外から届いた文書(他の人の変更を取り込んだもの)に置き換える。 */
	| { readonly type: "replace"; readonly lines: readonly Line[] };

type InitialContent = {
	/** 行IDを持たない最初の本文。 */
	readonly initialLines?: readonly string[] | undefined;
	/** 行IDを持つ最初の文書。行があれば、こちらを使う。 */
	readonly initialDocument?: readonly Line[] | undefined;
};

/** この端末が作る行IDの接頭辞。編集欄ごとに違う値にして、他の人や他のタブが作るIDと重ならないようにする。 */
export const createIdPrefix = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/**
 * 編集欄の最初の状態を作る。編集欄は常に1行以上を持つ。
 * prefix は、この端末が作る行IDの接頭辞。
 */
export function createModel(content: InitialContent, prefix: string): EditorModel {
	const { initialDocument = [], initialLines = [] } = content;
	return createHistory(
		initialDocument.length > 0
			? { lines: initialDocument, prefix, serial: 0 }
			: startTracking(initialLines, prefix),
	);
}

export function reduceModel(model: EditorModel, action: EditorAction): EditorModel {
	switch (action.type) {
		case "edit":
			return applyEdit(model, action.command, action);
		case "undo":
			return undo(model);
		case "redo":
			return redo(model);
		case "replace":
			return replaceLines(model, action.lines);
	}
}
