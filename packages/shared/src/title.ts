/** 正規化済みのページタイトル。ページの同一性の判定とリンクの照合に使う。 */
export type TitleLc = string & { readonly __brand: "TitleLc" };

/**
 * ページタイトルを照合用に正規化する。
 * 空白はアンダースコアに置き換え、英字は小文字にそろえる。
 */
export function toTitleLc(title: string): TitleLc {
	return title.replaceAll(" ", "_").toLowerCase() as TitleLc;
}
