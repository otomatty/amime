import { itemAt } from "@amime/shared";
import type { Line, LineId } from "./types.ts";

/** 上から(fromEnd なら下から)数えて、本文が一致し続ける行の数。 */
function commonLength(
	previous: readonly Line[],
	texts: readonly string[],
	fromEnd: boolean,
	limit: number,
): number {
	const at = (length: number, offset: number) => (fromEnd ? length - 1 - offset : offset);
	let count = 0;
	while (
		count < limit &&
		itemAt(previous, at(previous.length, count)).text === itemAt(texts, at(texts.length, count))
	) {
		count += 1;
	}
	return count;
}

/**
 * 編集後の本文の並びに、行IDを割り当てる。
 *
 * エディタの操作は本文の配列だけを扱う。編集の前後を見比べて、どの行が「同じ行」かをここで決める。
 * 1. 上と下から、本文が変わっていない行はそのまま。
 * 2. あいだの行は、本文が完全に同じ行どうしを対応させる(行を並べ替えても、IDが本文についていく)。
 * 3. 残った行は、上から順に対応させる(行の中の編集、行の分割と結合)。
 * 4. 対応する行がなければ、新しいIDを付ける。
 */
export function assignLineIds(
	previous: readonly Line[],
	texts: readonly string[],
	createId: () => LineId,
): readonly Line[] {
	const shorter = Math.min(previous.length, texts.length);
	const head = commonLength(previous, texts, false, shorter);
	if (head === previous.length && head === texts.length) return previous;
	const tail = commonLength(previous, texts, true, shorter - head);

	const oldMiddle = previous.slice(head, previous.length - tail);
	const newMiddle = texts.slice(head, texts.length - tail);

	// 本文が完全に同じ行を対応させる。同じ本文の行が複数あれば、上から順に使う。
	const sameText = Map.groupBy(oldMiddle, (line) => line.text);
	const matched = newMiddle.map((text) => sameText.get(text)?.shift());
	const used = new Set(matched.map((line) => line?.id));
	const rest = oldMiddle.filter((line) => !used.has(line.id));

	const middle = matched.map(
		(line, index) => line ?? { id: rest.shift()?.id ?? createId(), text: itemAt(newMiddle, index) },
	);
	return [...previous.slice(0, head), ...middle, ...previous.slice(previous.length - tail)];
}

/** 行IDを割り当てながら、本文の変化を追うための状態。 */
export type LineTracker = {
	readonly lines: readonly Line[];
	/** この端末が作る行IDの接頭辞。端末ごとに違う値にして、他の人が作るIDと重ならないようにする。 */
	readonly prefix: string;
	/** 次に作る行IDの連番。 */
	readonly serial: number;
};

/** 最初の本文に行IDを付けて、追跡を始める。 */
export function startTracking(texts: readonly string[], prefix: string): LineTracker {
	return trackLines({ lines: [], prefix, serial: 0 }, texts);
}

/** 編集後の本文に行IDを割り当てる。本文が変わっていなければ、同じものを返す。 */
export function trackLines(tracker: LineTracker, texts: readonly string[]): LineTracker {
	let { serial } = tracker;
	const lines = assignLineIds(tracker.lines, texts, () => {
		const id = `${tracker.prefix}-${serial.toString(36)}` as LineId;
		serial += 1;
		return id;
	});
	return lines === tracker.lines ? tracker : { lines, prefix: tracker.prefix, serial };
}
