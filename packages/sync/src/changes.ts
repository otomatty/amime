import { itemAt } from "@amime/shared";
import type { Applied, Change, Line, LineId, Placement } from "./types.ts";

const indexOfLine = (lines: readonly Line[], id: LineId | null): number =>
	lines.findIndex((line) => line.id === id);

/** 行を置く位置を決める。指定された前後の行がなくなっていても、必ずどこかに決まる。 */
function placeIndex(lines: readonly Line[], { after, before }: Placement): number {
	if (after === null) return 0;
	const afterIndex = indexOfLine(lines, after);
	if (afterIndex !== -1) return afterIndex + 1;
	const beforeIndex = indexOfLine(lines, before);
	return beforeIndex === -1 ? lines.length : beforeIndex;
}

/** 指定した位置の行の、実際の前後の行。 */
const neighbours = (lines: readonly Line[], index: number): Placement => ({
	after: lines[index - 1]?.id ?? null,
	before: lines[index + 1]?.id ?? null,
});

/** 変更を1つ適用する(lines を書き換える)。実際に効いた変更を返す。何も起きなければ null。 */
function applyChange(lines: Line[], change: Change): Change | null {
	switch (change.type) {
		case "insert": {
			if (indexOfLine(lines, change.line.id) !== -1) return null;
			const index = placeIndex(lines, change);
			lines.splice(index, 0, change.line);
			return { type: "insert", line: change.line, ...neighbours(lines, index) };
		}
		case "update": {
			const index = indexOfLine(lines, change.id);
			if (index === -1 || itemAt(lines, index).text === change.text) return null;
			lines[index] = { id: change.id, text: change.text };
			return change;
		}
		case "delete": {
			const index = indexOfLine(lines, change.id);
			if (index === -1) return null;
			lines.splice(index, 1);
			return change;
		}
		case "move": {
			const from = indexOfLine(lines, change.id);
			if (from === -1) return null;
			const line = itemAt(lines, from);
			lines.splice(from, 1);
			const to = placeIndex(lines, change);
			lines.splice(to, 0, line);
			return to === from ? null : { type: "move", id: change.id, ...neighbours(lines, to) };
		}
	}
}

/**
 * 変更を順番に適用した結果を返す。入力の配列は書き換えない。
 *
 * 失敗しない。対象の行がなくなっている変更は、その変更だけを捨てる
 * (他の人の変更が先に入ったあとでも、残りの変更を生かすため)。
 * - update / delete / move: 対象の行がなければ何もしない
 * - insert: 同じIDの行が既にあれば何もしない
 * - insert / move の位置: 前後の行がなくなっていたら、Placement の規則で近い位置に置く
 */
export function applyChanges(lines: readonly Line[], changes: readonly Change[]): Applied {
	const next = [...lines];
	const applied = changes
		.map((change) => applyChange(next, change))
		.filter((change) => change !== null);
	return { lines: applied.length === 0 ? lines : next, applied };
}

/**
 * 数列のうち、増え続ける最長の部分列に含まれる位置を返す。
 * 並べ替えの前後で「動かさなくてよい行」を、できるだけ多く選ぶのに使う。
 */
function longestIncreasing(values: readonly number[]): Set<number> {
	// tails[k]: 長さ k+1 の増加列のうち、末尾の値が最小になるものの、末尾の位置。
	const tails: number[] = [];
	const previous: number[] = [];
	values.forEach((value, position) => {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (itemAt(values, itemAt(tails, middle)) < value) low = middle + 1;
			else high = middle;
		}
		previous.push(low === 0 ? -1 : itemAt(tails, low - 1));
		tails[low] = position;
	});

	const positions = new Set<number>();
	for (let position = tails.at(-1) ?? -1; position !== -1; position = itemAt(previous, position)) {
		positions.add(position);
	}
	return positions;
}

/**
 * before を after にするための変更を求める。行の並べ替えは move で表す。
 * 求めた変更を before に適用すると、必ず after になる。
 */
export function diffLines(before: readonly Line[], after: readonly Line[]): Change[] {
	const beforeIndex = new Map(before.map((line, index) => [line.id, index]));
	const afterIds = new Set(after.map((line) => line.id));
	const changes: Change[] = before
		.filter((line) => !afterIds.has(line.id))
		.map((line) => ({ type: "delete", id: line.id }));

	// 前からある行のうち、互いの順序が変わっていない最大の組は動かさない。残りを move で動かす。
	const kept = after.flatMap((line) => {
		const index = beforeIndex.get(line.id);
		return index === undefined ? [] : [{ id: line.id, index }];
	});
	const inPlace = longestIncreasing(kept.map(({ index }) => index));
	const stays = new Set(kept.filter((_, position) => inPlace.has(position)).map(({ id }) => id));

	// 上から順に処理する。直前の行は必ず置き終わっているので、after の指す行が常に存在する。
	after.forEach((line, index) => {
		const placement = neighbours(after, index);
		const previousIndex = beforeIndex.get(line.id);
		if (previousIndex === undefined) {
			changes.push({ type: "insert", line, ...placement });
			return;
		}
		if (!stays.has(line.id)) changes.push({ type: "move", id: line.id, ...placement });
		if (itemAt(before, previousIndex).text !== line.text) {
			changes.push({ type: "update", id: line.id, text: line.text });
		}
	});
	return changes;
}
