import type { Cursor } from "@amime/editor-core";

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
 * セルの最初の文字より左(左の余白)ならセルの先頭、それ以外(文字の下や右の余白)ならセルの末尾。
 */
export function columnInCell(first: CharBox, cellEnd: number, clientX: number): number {
	return clientX < first.left ? first.start : cellEnd;
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

/** 押された要素と位置から、カーソルの移動先を求める。 */
export function cursorFromPoint(target: Element, clientX: number, clientY: number): Cursor {
	const line = target.closest("[data-line]");
	if (!line) return { line: LINE_END, column: LINE_END };
	const lineIndex = Number(line.getAttribute("data-line"));

	const char = target.closest("[data-column]");
	if (char) return { line: lineIndex, column: columnFromPoint(measure(char), clientX) };

	// テーブルのセルの余白。行全体ではなく、押したセルの中で位置を決める。
	const cell = target.closest("[data-cell-end]");
	const firstInCell = cell?.querySelector("[data-column]");
	if (cell && firstInCell) {
		const cellEnd = Number(cell.getAttribute("data-cell-end"));
		return { line: lineIndex, column: columnInCell(measure(firstInCell), cellEnd, clientX) };
	}

	const chars = Array.from(line.querySelectorAll("[data-column]"), measure);
	return { line: lineIndex, column: columnOnRow(chars, clientX, clientY) };
}
