import type { LineId } from "@amime/sync";
import type { RemoteCaret } from "./editor-line.tsx";

/** 他の人(端末)のカーソルの位置(ADR-0023)。 */
export type RemoteCursor = {
	/** 人(端末)を区別する値。 */
	readonly client: string;
	readonly line: LineId;
	readonly column: number;
};

/** 他の人のカーソルに使う色の数(editor.css の data-color と合わせる)。 */
export const REMOTE_COLORS = 8;

/**
 * 人ごとの色の番号。同じ人は、いつも同じ番号になる。
 * 名前を出せるようになるまで(ログインは P4)、色で人を見分ける。
 */
export function colorOf(client: string): number {
	let hash = 0;
	for (const character of client) {
		// 文字の並びから、ばらけた値を作る(31 を掛けて足していく、よくある方法)。32ビットに収める。
		hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
	}
	return Math.abs(hash) % REMOTE_COLORS;
}

/** 他の人のカーソルを、行ごとにまとめる。 */
export function caretsByLine(others: readonly RemoteCursor[]): Map<LineId, RemoteCaret[]> {
	const byLine = new Map<LineId, RemoteCaret[]>();
	for (const { client, line, column } of others) {
		const carets = byLine.get(line) ?? [];
		carets.push({ key: client, column, color: colorOf(client) });
		byLine.set(line, carets);
	}
	return byLine;
}
