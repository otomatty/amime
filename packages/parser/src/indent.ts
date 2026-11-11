export type IndentedLine = {
	/** インデントの深さ。行頭の空白文字1つにつき1。 */
	readonly indent: number;
	/** インデントを取り除いた本文。 */
	readonly text: string;
};

/** インデントとして扱わない最初の文字。半角スペース・タブ・全角スペース以外。 */
const FIRST_NON_INDENT = /[^ \t\u3000]/;

/** 行頭の半角スペース・タブ・全角スペースを、種類を問わず1文字1レベルとして数える。 */
export function parseIndent(raw: string): IndentedLine {
	const first = raw.search(FIRST_NON_INDENT);
	const indent = first === -1 ? raw.length : first;
	return { indent, text: raw.slice(indent) };
}
