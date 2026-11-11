import { err, ok, type Result } from "@amime/shared";
import type { ApplyError, Change, Line, LineId } from "./types.ts";

function applyChange(lines: Line[], change: Change): Result<null, ApplyError> {
	const indexOf = (id: LineId): number => lines.findIndex((line) => line.id === id);
	const notFound = (id: LineId) => err({ kind: "line-not-found", id } as const);

	switch (change.type) {
		case "insert": {
			if (indexOf(change.line.id) !== -1) {
				return err({ kind: "duplicate-line", id: change.line.id });
			}
			if (change.before === null) {
				lines.push(change.line);
				return ok(null);
			}
			const index = indexOf(change.before);
			if (index === -1) return notFound(change.before);
			lines.splice(index, 0, change.line);
			return ok(null);
		}
		case "update": {
			const index = indexOf(change.id);
			if (index === -1) return notFound(change.id);
			lines[index] = { id: change.id, text: change.text };
			return ok(null);
		}
		case "delete": {
			const index = indexOf(change.id);
			if (index === -1) return notFound(change.id);
			lines.splice(index, 1);
			return ok(null);
		}
	}
}

/**
 * 変更を順番に適用した結果を返す。入力の配列は書き換えない。
 * 1つでも適用できない変更があれば、全体を失敗として扱う。
 */
export function applyChanges(
	lines: readonly Line[],
	changes: readonly Change[],
): Result<readonly Line[], ApplyError> {
	const next = [...lines];
	for (const change of changes) {
		const result = applyChange(next, change);
		if (!result.ok) return result;
	}
	return ok(next);
}

/**
 * before を after にするための変更を求める。
 * 両方に存在する行は相対順序が変わっていないことを前提とする
 * (行の移動は「削除+新しいIDでの挿入」として表現する)。
 */
export function diffLines(before: readonly Line[], after: readonly Line[]): Change[] {
	const beforeText = new Map(before.map((line) => [line.id, line.text]));
	const afterIds = new Set(after.map((line) => line.id));

	const changes: Change[] = before
		.filter((line) => !afterIds.has(line.id))
		.map((line) => ({ type: "delete", id: line.id }));

	// 挿入位置の基準になる行が必ず先に存在するよう、末尾から順に処理する。
	let next: LineId | null = null;
	for (const line of after.toReversed()) {
		const previousText = beforeText.get(line.id);
		if (previousText === undefined) {
			changes.push({ type: "insert", before: next, line });
		} else if (previousText !== line.text) {
			changes.push({ type: "update", id: line.id, text: line.text });
		}
		next = line.id;
	}
	return changes;
}
