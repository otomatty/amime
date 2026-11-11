import type { Cursor } from "@amime/editor-core";

type CharBox = {
	/** 文字の開始位置と終了位置(行内の文字位置)。 */
	readonly start: number;
	readonly end: number;
	/** 画面上での左端と幅。 */
	readonly left: number;
	readonly width: number;
};

/** 文字のどちら側を押したかで、カーソルを文字の前に置くか後ろに置くかを決める。 */
export function columnFromPoint(char: CharBox, clientX: number): number {
	const pressedRightHalf = char.width > 0 && clientX >= char.left + char.width / 2;
	return pressedRightHalf ? char.end : char.start;
}

/** 行や文字の外を押したときに使う値。setCursor が存在する範囲に収める。 */
const BEYOND_END = Number.MAX_SAFE_INTEGER;

/** 押された要素と横位置から、カーソルの移動先を求める。 */
export function cursorFromPoint(target: Element, clientX: number): Cursor {
	const line = target.closest("[data-line]");
	if (!line) return { line: BEYOND_END, column: BEYOND_END };

	const lineIndex = Number(line.getAttribute("data-line"));
	const char = target.closest("[data-column]");
	if (!char) return { line: lineIndex, column: BEYOND_END };

	const { left, width } = char.getBoundingClientRect();
	const box = {
		start: Number(char.getAttribute("data-column")),
		end: Number(char.getAttribute("data-end")),
		left,
		width,
	};
	return { line: lineIndex, column: columnFromPoint(box, clientX) };
}
