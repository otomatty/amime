/** 正規化済みのページタイトル。ページの同一性の判定とリンクの照合に使う。 */
export type TitleLc = string & { readonly __brand: "TitleLc" };

/**
 * ページタイトルを照合用に正規化する。
 * 空白はアンダースコアに置き換え、英字は小文字にそろえる。
 */
export function toTitleLc(title: string): TitleLc {
	return title.replaceAll(" ", "_").toLowerCase() as TitleLc;
}

/** ページのタイトルの長さの上限(UTF-16 の符号単位)。URLに入れる名前なので、短く保つ。 */
export const MAX_TITLE_LENGTH = 200;

/** URLの中の名前を、タイトルにする。リンクのURLは空白をアンダースコアにしているので、空白に戻す。 */
export function titleFromName(name: string): string {
	return name.replaceAll("_", " ");
}

/** ページの1行目から、タイトルを求める。前後の空白は含めない。 */
export function titleOfLine(text: string): string {
	return text.trim();
}
