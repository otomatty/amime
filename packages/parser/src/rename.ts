import { toTitleLc } from "@amime/shared";
import { classifyLines } from "./blocks.ts";
import { parseLine } from "./line.ts";
import { inlineNodes } from "./summary.ts";
import type { InlineNode, LineRole } from "./types.ts";

/** 書き換えた行。 */
type RenamedLine = {
	/** 行番号(0始まり)。 */
	readonly index: number;
	/** 書き換えたあとの、行の文字列。 */
	readonly text: string;
};

/** written だけの行を解析して、1つのリンクになるなら、そのリンク先の名前。ならなければ null。 */
function linkedTitle(written: string, type: "page-link" | "hashtag"): string | null {
	const [node] = inlineNodes(parseLine(written, { kind: "text", blockIndent: 0 }));
	return node?.type === type && node.end === written.length ? node.title : null;
}

/**
 * to へのリンクの書き方。タグは、書けるならタグのままにする。
 * 書いたものが、to へのリンクとして読めることを確かめる(URLや装飾の記法として読める名前がある)。
 * リンクとして書けない名前なら null。
 */
function writeLink(to: string, type: "page-link" | "hashtag"): string | null {
	const tag = `#${to.replaceAll(" ", "_")}`;
	if (type === "hashtag" && toTitleLc(linkedTitle(tag, "hashtag") ?? "") === toTitleLc(to)) {
		return tag;
	}
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
 * 1行の中の、from へのリンクを、to へのリンクに書き換える。書き換えなければ null。
 * 書き換えた行を読み直して、リンクが、そのとおりに読まれることを確かめる。読まれ方が変わるなら、書き換えない。
 */
function renameInLine(raw: string, role: LineRole, fromLc: string, to: string): string | null {
	let text = raw;
	// 書き換えたあとの行にあるはずの、リンクの行き先。
	const expected: string[] = [];
	// 後ろから書き換える。前のリンクの位置が、ずれない。
	for (const node of linksIn(raw, role).reverse()) {
		const linked = toTitleLc(node.title);
		const written = linked === fromLc ? writeLink(to, node.type) : null;
		expected.unshift(written === null ? linked : toTitleLc(to));
		if (written !== null) text = text.slice(0, node.start) + written + text.slice(node.end);
	}
	const actual = linksIn(text, role).map((node) => toTitleLc(node.title));
	return text !== raw && actual.join("\n") === expected.join("\n") ? text : null;
}

/**
 * ページの名前が from から to に変わったとき、そのページへのリンクを書き換える(ADR-0028)。
 * 書き換えた行だけを返す。1行目(タイトル)と、コードの中は書き換えない。
 * to がリンクとして書けない名前なら、書き換えない(リンクは、前の名前を指したまま残る)。
 * 書き換えると、行の中のリンクの読まれ方が変わってしまうとき(名前の中の記号が、他の記法と組になるなど)は、
 * その行を書き換えない。
 */
export function renameLinks(lines: readonly string[], from: string, to: string): RenamedLine[] {
	const fromLc = toTitleLc(from);
	const roles = classifyLines(lines);

	return lines.flatMap((raw, index) => {
		const role = roles[index];
		if (index === 0 || role === undefined) return [];
		const text = renameInLine(raw, role, fromLc, to);
		return text === null ? [] : [{ index, text }];
	});
}
