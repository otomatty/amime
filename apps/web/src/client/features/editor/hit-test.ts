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

/**
 * 折り返された行の余白を押したときの列を求める。
 * 押した高さにある表示上の段だけを見て、その段の中で最も近い文字の位置を返す。
 * どの段にも当たらなければ null。
 */
export function columnOnRow(
	chars: readonly CharBox[],
	clientX: number,
	clientY: number,
): number | null {
	const row = chars.filter((char) => clientY >= char.top && clientY < char.top + char.height);
	const first = row[0];
	const last = row.at(-1);
	if (!first || !last) return null;

	if (clientX < first.left) return first.start;
	if (clientX >= last.left + last.width) return last.end;
	const nearest = row.reduce((best, char) =>
		distance(char, clientX) < distance(best, clientX) ? char : best,
	);
	return columnFromPoint(nearest, clientX);
}

const distance = (char: CharBox, clientX: number): number =>
	Math.abs(char.left + char.width / 2 - clientX);

/** 行や文字の外を押したときに使う値。setCursor が存在する範囲に収める。 */
const BEYOND_END = Number.MAX_SAFE_INTEGER;

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
	if (!line) return { line: BEYOND_END, column: BEYOND_END };
	const lineIndex = Number(line.getAttribute("data-line"));

	const char = target.closest("[data-column]");
	if (char) return { line: lineIndex, column: columnFromPoint(measure(char), clientX) };

	const chars = Array.from(line.querySelectorAll("[data-column]"), measure);
	return { line: lineIndex, column: columnOnRow(chars, clientX, clientY) ?? BEYOND_END };
}
