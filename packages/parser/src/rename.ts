import { toTitleLc } from "@tsuzuri/shared";
import { classifyLines } from "./blocks.ts";
import { parseLine } from "./line.ts";
import { inlineNodes } from "./summary.ts";
import type { InlineNode, LineRole } from "./types.ts";

/** ページの名前の変更。 */
export type Rename = {
	/** 前の名前。 */
	readonly from: string;
	/** 新しい名前。 */
	readonly to: string;
};

/** 書き換えた行。 */
type RenamedLine = {
	/** 行番号(0始まり)。 */
	readonly index: number;
	/** 書き換えたあとの、行の文字列。 */
	readonly text: string;
	/** この行で書き換えたリンクの、前の名前(正規化したもの)。出てきた順。同じ名前は1つにまとめる。 */
	readonly renamed: readonly string[];
};

/** written だけの行を解析して、1つのリンクになるなら、そのリンク先の名前。ならなければ null。 */
function linkedTitle(written: string, type: "page-link" | "hashtag"): string | null {
	// 1つのリンクだけを書いた行なので、行の役割(ふつうの行)は、どの指定でも読み方が変わらない。
	// Stryker disable next-line ObjectLiteral,StringLiteral: 上のとおり、結果は変わらない
	const [node] = inlineNodes(parseLine(written, { kind: "text", blockIndent: 0 }));
	// 種類と終わりの確かめは、呼ぶ側の名前の比べ(同じ名前か)にも含まれる。読み手のために、ここでも書く。
	return node?.type === type && node.end === written.length ? node.title : null;
}

/**
 * to へのリンクの書き方([名前] か #名前)。type が hashtag なら、書けるならタグにする。
 * 書いたものが、to へのリンクとして読めることを確かめる(URLや装飾の記法として読める名前がある)。
 * リンクとして書けない名前なら null。
 */
export function writePageLink(to: string, type: "page-link" | "hashtag"): string | null {
	const tag = `#${to.replaceAll(" ", "_")}`;
	// タグとして読めないとき(null)は、名前と比べない。空の名前は、「#」が読めない名前とも同じになってしまう。
	const tagged = type === "hashtag" ? linkedTitle(tag, "hashtag") : null;
	// 終わりまでタグとして読めたなら、その名前は to と同じ(空白をアンダースコアにしただけ)。名前の比べは、確かめのために書く。
	if (tagged !== null && toTitleLc(tagged) === toTitleLc(to)) return tag;
	const bracket = `[${to}]`;
	return linkedTitle(bracket, "page-link") === to ? bracket : null;
}

type LinkNode = Extract<InlineNode, { type: "page-link" | "hashtag" }>;

const isLink = (node: InlineNode): node is LinkNode =>
	node.type === "page-link" || node.type === "hashtag";

/** 行の中の、ページへのリンク。出てくる順。 */
const linksIn = (raw: string, role: LineRole): LinkNode[] =>
	inlineNodes(parseLine(raw, role)).filter(isLink);

/**
 * 1行の中のリンクを、行き先の新しい名前(targets。正規化した前の名前から、新しい名前へ)に書き換える。
 * 書き換えなければ null。それぞれのリンクは、元の行き先だけを見て書き換える(書き換えた結果を、もう1度書き換えない)。
 * 書き換えた行を読み直して、リンクが、そのとおりに読まれることを確かめる。読まれ方が変わるなら、書き換えない。
 */
function renameInLine(
	raw: string,
	role: LineRole,
	targets: ReadonlyMap<string, string>,
): Omit<RenamedLine, "index"> | null {
	let text = raw;
	// 書き換えたあとの行にあるはずの、リンクの行き先。
	const expected: string[] = [];
	const renamed: string[] = [];
	// 後ろから書き換える。前のリンクの位置が、ずれない。
	for (const node of linksIn(raw, role).reverse()) {
		const linked = toTitleLc(node.title);
		const to = targets.get(linked);
		const written = to === undefined ? null : writePageLink(to, node.type);
		// to がなければ、written も null。to === undefined は、型を絞るために書く。
		expected.unshift(to === undefined || written === null ? linked : toTitleLc(to));
		if (written === null) continue;
		text = text.slice(0, node.start) + written + text.slice(node.end);
		renamed.unshift(linked);
	}
	const actual = linksIn(text, role).map((node) => toTitleLc(node.title));
	// 並びをそのまま比べる(改行でつなぐと、リンクがないことと、空の名前のリンクが1つあることが、同じになる)。
	if (text === raw || JSON.stringify(actual) !== JSON.stringify(expected)) return null;
	return { text, renamed: [...new Set(renamed)] };
}

/**
 * ページの名前が変わったとき、そのページへのリンクを書き換える(ADR-0028)。
 * いくつかの名前の変更を、まとめて書き換える(同じ名前からの変更が2つあれば、先のものを使う)。
 * 書き換えた行だけを返す。1行目(タイトル)と、コードの中は書き換えない。
 * 新しい名前がリンクとして書けない名前なら、書き換えない(リンクは、前の名前を指したまま残る)。
 * 書き換えると、行の中のリンクの読まれ方が変わってしまうとき(名前の中の記号が、他の記法と組になるなど)は、
 * その行を書き換えない。
 */
export function renameLinks(lines: readonly string[], renames: readonly Rename[]): RenamedLine[] {
	const targets = new Map<string, string>();
	for (const { from, to } of renames) {
		if (!targets.has(toTitleLc(from))) targets.set(toTitleLc(from), to);
	}
	const roles = classifyLines(lines);

	return lines.flatMap((raw, index) => {
		const role = roles[index];
		// 1行目は、タイトルとして読む(リンクを読まない)ので、ここで外さなくても書き換わらない。
		// role は、行と同じ数だけある。どちらも、読み手のために書く。
		if (index === 0 || role === undefined) return [];
		const line = renameInLine(raw, role, targets);
		return line === null ? [] : [{ index, ...line }];
	});
}
