/** 行を一意に識別するID。行の本文が変わっても、行が移動しない限り変わらない。 */
export type LineId = string & { readonly __brand: "LineId" };

export type Line = {
	readonly id: LineId;
	readonly text: string;
};

/** ページへの変更の最小単位。すべて行IDで対象を指す。 */
export type Change =
	| { readonly type: "insert"; readonly before: LineId | null; readonly line: Line }
	| { readonly type: "update"; readonly id: LineId; readonly text: string }
	| { readonly type: "delete"; readonly id: LineId };

export type ApplyError =
	| { readonly kind: "line-not-found"; readonly id: LineId }
	| { readonly kind: "duplicate-line"; readonly id: LineId };
