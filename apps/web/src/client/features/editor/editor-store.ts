import type { Line } from "@amime/sync";
import { type EditorAction, type EditorModel, reduceModel } from "./editor-model.ts";

/**
 * 編集欄の状態の置き場所。
 *
 * 状態は、操作を受け取ったその場で進める。編集後の文書も、その場で知らせる。
 * 保存の側(ページの同期)と編集欄が、いつも同じ文書を見ているようにするためである。
 * 描画のあとで知らせる方式だと、知らせるまでのあいだに届いた他の人の変更を、
 * 古い文書をもとに取り込んでしまう(ADR-0018)。
 */
export type EditorStore = {
	readonly getModel: () => EditorModel;
	/** 状態が変わったときに呼ぶ関数を登録する(描き直しのため)。返した関数で登録をやめる。 */
	readonly subscribe: (listener: () => void) => () => void;
	/**
	 * 自分の編集で文書が変わったときに呼ぶ関数を登録する。返した関数で登録をやめる。
	 * 外から届いた文書への置き換えでは呼ばない。ただし、置き換えた結果を編集欄が補ったとき
	 * (すべての行が消されていて、空の1行を置いたとき)は、その文書を知らせる。
	 */
	readonly onEdit: (listener: (lines: readonly Line[]) => void) => () => void;
	readonly dispatch: (action: EditorAction) => void;
};

function register<T>(listeners: Set<T>, listener: T): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function createEditorStore(initial: EditorModel): EditorStore {
	let model = initial;
	const renderers = new Set<() => void>();
	const editListeners = new Set<(lines: readonly Line[]) => void>();

	return {
		getModel: () => model,
		subscribe: (listener) => register(renderers, listener),
		onEdit: (listener) => register(editListeners, listener),
		dispatch(action) {
			const previous = model;
			model = reduceModel(previous, action);
			if (model === previous) return;
			for (const listener of renderers) listener();

			const { lines } = model.tracker;
			// 置き換えのときは、渡された文書がそのまま画面の文書になる。違っていれば、編集欄が補っている。
			const given = action.type === "replace" ? action.lines : previous.tracker.lines;
			if (lines !== given) for (const listener of editListeners) listener(lines);
		},
	};
}
