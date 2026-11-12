import type { LineKind } from "@amime/parser";

/** 連続する行のまとまり。start 行目から end 行目の手前まで。 */
export type LineGroup = {
	/** テーブルの行だけからなるまとまりか。 */
	readonly table: boolean;
	readonly start: number;
	readonly end: number;
};

/**
 * 行を、描画のためのまとまりに分ける。
 * 連続するテーブルの行は、列の幅をそろえるために1つの枠で囲む必要があるので、1つにまとめる。
 * それ以外の行も、連続するものを1つにまとめる。
 */
export function groupLines(kinds: readonly LineKind[]): LineGroup[] {
	const groups: LineGroup[] = [];
	let start = 0;
	kinds.forEach((kind, index) => {
		const table = kind === "table-row";
		const nextIsSame = (kinds[index + 1] === "table-row") === table;
		if (index + 1 < kinds.length && nextIsSame) return;
		groups.push({ table, start, end: index + 1 });
		start = index + 1;
	});
	return groups;
}
