import { parseIndent } from "./indent.ts";
import type { LineKind, LineRole } from "./types.ts";

type Block = "code" | "table";

/** 複数行にまたがる記法の、始まりの行の形。 */
export type BlockHead = {
	readonly block: Block;
	/** 「code:」「table:」の部分。 */
	readonly prefix: string;
};

const BLOCK_HEADS: readonly BlockHead[] = [
	{ block: "code", prefix: "code:" },
	{ block: "table", prefix: "table:" },
];

export const HEAD_KIND: Readonly<Record<Block, "code-head" | "table-head">> = {
	code: "code-head",
	table: "table-head",
};

const BODY_KIND: Readonly<Record<Block, LineKind>> = {
	code: "code-body",
	table: "table-row",
};

/**
 * インデントを除いた行の本文が、ブロックの始まり(code:名前、table:名前)かどうかを調べる。
 * 名前は空であってはならない。
 */
export function matchBlockHead(text: string): BlockHead | null {
	const head = BLOCK_HEADS.find(({ prefix }) => text.startsWith(prefix));
	if (head === undefined || text.slice(head.prefix.length).trim() === "") return null;
	return head;
}

const TITLE: LineRole = { kind: "title", blockIndent: 0 };
const TEXT: LineRole = { kind: "text", blockIndent: 0 };

/**
 * ページの各行の役割を決める。
 *
 * - 1行目はタイトル。
 * - 「code:名前」「table:名前」の行からブロックが始まる。
 * - ブロックの中身は、始まりの行より深くインデントされた行が続くあいだ。
 *   同じか浅いインデントの行(空行を含む)でブロックは終わる。
 *
 * 行ごとの解析(parseLine)は前後の行を見ないので、行をまたぐ判断はここに集める。
 * 行数に比例する軽い処理で、編集のたびにページ全体について呼んでよい。
 */
export function classifyLines(lines: readonly string[]): LineRole[] {
	let open: { readonly block: Block; readonly indent: number } | null = null;

	return lines.map((line, index) => {
		if (index === 0) return TITLE;
		const { indent, text } = parseIndent(line);
		if (open !== null && indent > open.indent) {
			return { kind: BODY_KIND[open.block], blockIndent: open.indent };
		}

		const head = matchBlockHead(text);
		if (head === null) {
			open = null;
			return TEXT;
		}
		open = { block: head.block, indent };
		return { kind: HEAD_KIND[head.block], blockIndent: indent };
	});
}
