/**
 * ページのAPIの失敗。
 * - disabled: この環境ではページのAPIが無効(認証が入るまでの公開環境)
 * - rejected: 送った内容をサーバーが受け付けない(長すぎる行など)。同じ内容を送り直しても通らない
 * - failed: 通信やサーバーの失敗、想定と違う応答。送り直せば通るかもしれない
 * - gone: ページが削除されている(ADR-0026)。読み込みも書き込みもできない
 */
export class PageApiError extends Error {
	override readonly name = "PageApiError";
	readonly kind: "disabled" | "rejected" | "failed" | "gone";

	constructor(kind: PageApiError["kind"]) {
		super(`page api ${kind}`);
		this.kind = kind;
	}
}
