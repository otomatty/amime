import type { Cursor } from "@amime/editor-core";
import type { Span } from "@amime/parser";

/** 画面上の1文字の位置。 */
export type CharBox = {
	/** 文字の開始位置と終了位置(行内の文字位置)。 */
	readonly start: number;
	readonly end: number;
	readonly left: number;
	readonly width: number;
	readonly top: number;
	readonly height: number;
};

/** 文字のどちら側を押したかで、カーソルを文字の前に置くか後ろに置くかを決める。 */
export function columnFromPoint(char: CharBox, clientX: number): number {
	const pressedRightHalf = char.width > 0 && clientX >= char.left + char.width / 2;
	return pressedRightHalf ? char.end : char.start;
}

/** 押した高さと文字の矩形との縦の距離。矩形の中なら 0。 */
const verticalDistance = (char: CharBox, clientY: number): number =>
	Math.max(char.top - clientY, clientY - (char.top + char.height), 0);

/**
 * テーブルのセルの中で、文字以外のところを押したときの列を求める。
 * セルの最初に見えている文字より左(左の余白)ならセルの先頭、それ以外(文字の下や右の余白)ならセルの末尾。
 * 先頭と末尾は、見えている文字の位置ではなくセルの範囲から決める(セルの端の記法が隠れていても正しい位置になる)。
 */
export function columnInCell(firstVisible: CharBox, cell: Span, clientX: number): number {
	return clientX < firstVisible.left ? cell.start : cell.end;
}

type Row = { readonly top: number; readonly bottom: number };

/** 押した高さに最も近い行の番号。同じ近さなら後ろの行。行がなければ -1。 */
export function nearestRow(rows: readonly Row[], clientY: number): number {
	let nearest = -1;
	let shortest = Number.POSITIVE_INFINITY;
	rows.forEach((row, index) => {
		const distance = Math.max(row.top - clientY, clientY - row.bottom, 0);
		if (distance <= shortest) {
			nearest = index;
			shortest = distance;
		}
	});
	return nearest;
}

/** 「行末」を表す文字位置。setCursor が実際の行の長さに収める。 */
export const LINE_END = Number.MAX_SAFE_INTEGER;

/**
 * 文字以外の行の余白を押したときの列を求める。
 * 押した高さに最も近い表示上の段(折り返された行の1段)を選び、その段の中で最も近い位置を返す。
 * 段の間の隙間や、最後の段より下を押した場合も、縦に最も近い段で決める。
 *
 * 行全体の最初の文字より左は行頭、最後の文字より右は行末にする。
 * 装飾して表示している行では記法の記号が隠れているので、見えている文字の端ではなく
 * 行の端にしないと、行末を押したつもりが「]」の内側に入力されてしまう。
 */
export function columnOnRow(chars: readonly CharBox[], clientX: number, clientY: number): number {
	// 大きさが0の文字は位置を判断できないので使わない(画面に描画されていない場合など)。
	const measurable = chars.filter((char) => char.width > 0 && char.height > 0);
	const [firstChar, ...rest] = measurable;
	if (!firstChar) return LINE_END;
	const closestVertically = rest.reduce(
		(best, char) =>
			verticalDistance(char, clientY) < verticalDistance(best, clientY) ? char : best,
		firstChar,
	);
	// 同じ段の文字は、選んだ文字の縦の中心を含む。
	const rowCenter = closestVertically.top + closestVertically.height / 2;
	const row = measurable.filter(
		(char) => rowCenter >= char.top && rowCenter < char.top + char.height,
	);
	const first = row[0] ?? closestVertically;
	const last = row.at(-1) ?? closestVertically;

	if (clientX < first.left) return first === firstChar ? 0 : first.start;
	if (clientX >= last.left + last.width) return last === measurable.at(-1) ? LINE_END : last.end;
	const closestHorizontally = row.reduce(
		(best, char) =>
			horizontalDistance(char, clientX) < horizontalDistance(best, clientX) ? char : best,
		first,
	);
	return columnFromPoint(closestHorizontally, clientX);
}

/** 押した横位置と、文字の横の中心との距離。 */
const horizontalDistance = (char: CharBox, clientX: number): number =>
	Math.abs(char.left + char.width / 2 - clientX);

function measure(element: Element): CharBox {
	const { left, width, top, height } = element.getBoundingClientRect();
	return {
		start: Number(element.getAttribute("data-column")),
		end: Number(element.getAttribute("data-end")),
		left,
		width,
		top,
		height,
	};
}

const DOCUMENT_START: Cursor = { line: 0, column: 0 };
const DOCUMENT_END: Cursor = { line: LINE_END, column: LINE_END };

/**
 * 行のない場所(テーブルの右の余白、編集欄の外など)を押したときに、位置を決めるのに使う行を探す。
 * すべての行より上なら文書の先頭、下なら文書の末尾。そのあいだなら、押した高さに最も近い行。
 */
function lineNear(root: Element | null, clientY: number): Element | Cursor {
	const lines = root ? [...root.querySelectorAll("[data-line]")] : [];
	const rows = lines.map((line) => line.getBoundingClientRect());
	const first = rows[0];
	const last = rows.at(-1);
	if (!first || !last || clientY >= last.bottom) return DOCUMENT_END;
	if (clientY < first.top) return DOCUMENT_START;
	return lines[nearestRow(rows, clientY)] ?? DOCUMENT_END;
}

/**
 * 押された要素と位置から、カーソルの移動先を求める。
 * root は編集欄の要素。行のない場所を押したときに、近くの行を探すのに使う。
 */
export function cursorFromPoint(
	target: Element,
	clientX: number,
	clientY: number,
	root: Element | null = null,
): Cursor {
	const line = target.closest("[data-line]") ?? lineNear(root, clientY);
	if (!(line instanceof Element)) return line;
	const lineIndex = Number(line.getAttribute("data-line"));

	const char = target.closest("[data-column]");
	if (char) return { line: lineIndex, column: columnFromPoint(measure(char), clientX) };

	// テーブルのセルの余白。行全体ではなく、押したセルの中で位置を決める。
	const cell = target.closest("[data-cell-start]");
	const firstInCell = cell?.querySelector("[data-column]");
	if (cell && firstInCell) {
		const range = {
			start: Number(cell.getAttribute("data-cell-start")),
			end: Number(cell.getAttribute("data-cell-end")),
		};
		return { line: lineIndex, column: columnInCell(measure(firstInCell), range, clientX) };
	}

	const chars = Array.from(line.querySelectorAll("[data-column]"), measure);
	return { line: lineIndex, column: columnOnRow(chars, clientX, clientY) };
}
