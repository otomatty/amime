/** 行を一意に識別するID。行の本文が変わっても、行を動かしても変わらない。 */
export type LineId = string & { readonly __brand: "LineId" };

export type Line = {
	readonly id: LineId;
	readonly text: string;
};

/**
 * 行を置く位置。前後の行で指す。次の順に決める。
 * 1. after が null なら先頭。
 * 2. after の行があれば、その直後。
 * 3. before の行があれば、その直前。
 * 4. どちらの行もなければ末尾。
 * 前後の両方を持つのは、after の行を他の人が消していても、近い位置に置けるようにするため。
 */
export type Placement = {
	readonly after: LineId | null;
	readonly before: LineId | null;
};

/** ページへの変更の最小単位。すべて行IDで対象を指す。 */
export type Change =
	| ({ readonly type: "insert"; readonly line: Line } & Placement)
	| { readonly type: "update"; readonly id: LineId; readonly text: string }
	| { readonly type: "delete"; readonly id: LineId }
	| ({ readonly type: "move"; readonly id: LineId } & Placement);

/** 変更を適用した結果。 */
export type Applied = {
	readonly lines: readonly Line[];
	/**
	 * 実際に効いた変更。何も起きなかった変更は含まない。
	 * 挿入と移動の位置は、実際に置いた場所の前後の行に書き直してある。
	 * 適用する前と同じ文書にこれを適用すれば、同じ結果になる。
	 */
	readonly applied: readonly Change[];
};

/** ある時点のページ。 */
export type PageSnapshot = {
	/** コミットが効くたびに1ずつ増える。 */
	readonly version: number;
	readonly lines: readonly Line[];
};

/** コミットへの応答。 */
export type CommitResult = {
	/** 適用後のバージョン。何も効かなければ進まない。 */
	readonly version: number;
	/** 実際に効いた変更。 */
	readonly applied: readonly Change[];
};

/** 端末(タブ)を識別するID。自分のコミットを、自分の接続に配信しないために使う。 */
export type ClientId = string & { readonly __brand: "ClientId" };

/** クライアントが送るコミット。 */
export type CommitRequest = {
	readonly changes: readonly Change[];
	/**
	 * 送った端末(タブ)の識別子。サーバーは、同じ識別子で接続している WebSocket にはこのコミットを配信しない
	 * (送った本人は、応答で結果を受け取るため)。
	 */
	readonly client?: ClientId | undefined;
};

/** サーバーが WebSocket で送るメッセージ。 */
export type ServerMessage =
	/** 接続した直後に送る。クライアントは、自分の持つバージョンより進んでいたら読み直す。 */
	| { readonly type: "hello"; readonly version: number }
	/** 他の端末のコミットが効いたときに送る。 */
	| ({ readonly type: "commit" } & CommitResult);

/** 端末内に残す、未送信の変更の記録。 */
export type PendingRecord = {
	/** 残した時刻(ミリ秒)。 */
	readonly savedAt: number;
	readonly changes: readonly Change[];
};
