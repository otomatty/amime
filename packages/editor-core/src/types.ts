export type Cursor = {
	/** 0始まりの行番号。 */
	readonly line: number;
	/** 行内の0始まりの文字位置。行の長さと等しいとき行末を指す。 */
	readonly column: number;
};

/** エディタの状態。コマンドはこれを書き換えず、新しい状態を返す。 */
export type EditorState = {
	readonly lines: readonly string[];
	readonly cursor: Cursor;
	/**
	 * 範囲選択の始点。選択していなければ持たない。
	 * 選択範囲は anchor と cursor のあいだで、どちらが文書の前にあってもよい。
	 */
	readonly anchor?: Cursor;
};
