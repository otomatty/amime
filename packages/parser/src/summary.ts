import { toTitleLc } from "@amime/shared";
import { classifyLines } from "./blocks.ts";
import { parseLine } from "./line.ts";
import type { InlineNode, ParsedLine } from "./types.ts";

/** 冒頭の本文として取り出す行の数。 */
const DESCRIPTION_LINES = 5;
/** 冒頭の本文の、1行の長さの上限(UTF-16 の符号単位)。 */
const DESCRIPTION_LENGTH = 200;
/** 1ページから取り出すリンクの数の上限。 */
export const MAX_SUMMARY_LINKS = 1000;

/** 一覧やリンクのつながりのために、ページから取り出す情報。 */
export type PageSummary = {
	/** ページの中のリンク先(ページの名前)。同じ名前は1つにまとめる。出てきた順。 */
	readonly links: readonly string[];
	/** 冒頭の本文(タイトルの次の行から)。記法の記号を除いた文字列。 */
	readonly descriptions: readonly string[];
	/** ページの中の最初の画像のURL。なければ null。 */
	readonly image: string | null;
};

/** 行の中の、記法のノード(入れ子の中も含む)。 */
function nodesOf(line: ParsedLine): readonly InlineNode[] {
	if (line.kind === "text" || line.kind === "title") return line.nodes;
	return line.kind === "table-row" ? line.cells.flatMap((cell) => cell.nodes) : [];
}

/** ノードと、その中に入れ子になっているノードを、出てくる順に並べる。 */
function flatten(nodes: readonly InlineNode[]): InlineNode[] {
	return nodes.flatMap((node) => ("children" in node ? [node, ...flatten(node.children)] : [node]));
}

/** 行の中の、記法のノードを、入れ子の中も含めて、出てくる順に並べる。 */
export function inlineNodes(line: ParsedLine): InlineNode[] {
	return flatten(nodesOf(line));
}

/** ノードを、読める文字列にする。記法の記号は除く。画像とアイコンは文字にしない。 */
function textOf(raw: string, node: InlineNode): string {
	if (node.type === "text") return raw.slice(node.start, node.end);
	if (node.type === "image" || node.type === "icon") return "";
	if ("children" in node) return node.children.map((child) => textOf(raw, child)).join("");
	return raw.slice(node.content.start, node.content.end);
}

/** 行を、読める文字列にする。 */
function plainText(raw: string, line: ParsedLine): string {
	switch (line.kind) {
		case "code-head":
		case "table-head":
			return raw.slice(line.name.start, line.name.end);
		case "code-body":
			return raw.slice(line.content.start, line.content.end);
		case "table-row":
			return line.cells
				.map((cell) => cell.nodes.map((node) => textOf(raw, node)).join(""))
				.join(" ");
		default:
			return line.nodes.map((node) => textOf(raw, node)).join("");
	}
}

/**
 * ページの行を、読める文字列にする(記法の記号を除く)。行の数と順は、そのまま。
 * 1行目はタイトルなので、記法として読まない。
 */
export function plainLines(lines: readonly string[]): string[] {
	const roles = classifyLines(lines);
	return lines.map((raw, index) => {
		const role = roles[index];
		return index === 0 || role === undefined ? raw : plainText(raw, parseLine(raw, role));
	});
}

/** 長さの上限に収める。文字(サロゲートの組)の途中では切らない。 */
function clip(text: string): string {
	if (text.length <= DESCRIPTION_LENGTH) return text;
	const clipped = text.slice(0, DESCRIPTION_LENGTH);
	// 上位サロゲートで終わっていたら、組の片方だけが残っている。取り除く。
	return clipped.isWellFormed() ? clipped : clipped.slice(0, -1);
}

/**
 * ページの行から、一覧やリンクのつながりのための情報を取り出す。
 * 1行目はタイトルなので、記法として読まず、冒頭の本文にも含めない。
 */
export function summarizePage(lines: readonly string[]): PageSummary {
	const roles = classifyLines(lines);
	const body = lines.flatMap((raw, index) => {
		const role = roles[index];
		return index === 0 || role === undefined ? [] : [{ raw, parsed: parseLine(raw, role) }];
	});
	const nodes = body.flatMap(({ parsed }) => inlineNodes(parsed));

	// 同じ名前へのリンクは、最初に出てきた表記で1つにまとめる。
	const links = new Map<string, string>();
	for (const node of nodes) {
		if (node.type !== "page-link" && node.type !== "hashtag") continue;
		const key = toTitleLc(node.title);
		if (!links.has(key) && links.size < MAX_SUMMARY_LINKS) links.set(key, node.title);
	}

	const descriptions = body
		.map(({ raw, parsed }) => plainText(raw, parsed).trim())
		.filter((text) => text !== "")
		.slice(0, DESCRIPTION_LINES)
		.map(clip);
	const image = nodes.find((node) => node.type === "image")?.src ?? null;
	return { links: [...links.values()], descriptions, image };
}
