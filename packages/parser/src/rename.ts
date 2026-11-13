import { toTitleLc } from "@amime/shared";
import { classifyLines } from "./blocks.ts";
import { parseLine } from "./line.ts";
import { inlineNodes } from "./summary.ts";
import type { InlineNode } from "./types.ts";

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

/**
 * ページの名前が from から to に変わったとき、そのページへのリンクを書き換える(ADR-0028)。
 * 書き換えた行だけを返す。1行目(タイトル)と、コードの中は書き換えない。
 * to がリンクとして書けない名前なら、書き換えない(リンクは、前の名前を指したまま残る)。
 */
export function renameLinks(lines: readonly string[], from: string, to: string): RenamedLine[] {
	const fromLc = toTitleLc(from);
	const isTarget = (
		node: InlineNode,
	): node is Extract<InlineNode, { type: "page-link" | "hashtag" }> =>
		(node.type === "page-link" || node.type === "hashtag") && toTitleLc(node.title) === fromLc;
	const roles = classifyLines(lines);

	return lines.flatMap((raw, index) => {
		const role = roles[index];
		if (index === 0 || role === undefined) return [];
		// 後ろから書き換える。前のリンクの位置が、ずれない。
		const targets = inlineNodes(parseLine(raw, role)).filter(isTarget).reverse();
		let text = raw;
		for (const node of targets) {
			const written = writeLink(to, node.type);
			if (written !== null) text = text.slice(0, node.start) + written + text.slice(node.end);
		}
		return text === raw ? [] : [{ index, text }];
	});
}
