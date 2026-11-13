import { applyChanges, diffLines } from "./changes.ts";
import { mergeText } from "./merge-text.ts";
import { MAX_LINE_LENGTH } from "./schema.ts";
import type { Change, Line, LineId } from "./types.ts";

/**
 * 自分が行った1回分の編集の記録(ADR-0019)。
 * 文書の状態ではなく、行IDを対象にした変更で覚える。あとから他の人の変更が入っていても、
 * 自分の変更だけを打ち消したり、もう一度行ったりできる。
 */
export type OwnEdit = {
	/** 編集そのもの。編集の前の文書を、編集のあとの文書にする変更。 */
	readonly forward: readonly Change[];
	/** 編集を打ち消す変更。編集のあとの文書を、編集の前の文書にする変更。 */
	readonly backward: readonly Change[];
};

/** 編集の前後の文書から、その編集を記録する。 */
export function recordEdit(before: readonly Line[], after: readonly Line[]): OwnEdit {
	return { forward: diffLines(before, after), backward: diffLines(after, before) };
}

/** 変更の列が、それぞれの行に書き込む本文(行を足す変更と、本文を置き換える変更)。 */
function writtenTexts(changes: readonly Change[]): Map<LineId, string> {
	const texts = new Map<LineId, string>();
	for (const change of changes) {
		if (change.type === "insert") texts.set(change.line.id, change.line.text);
		if (change.type === "update") texts.set(change.id, change.text);
	}
	return texts;
}

/**
 * 自分の編集を打ち消す(または、もう一度行う)変更を、他の人の変更を残して適用する。
 * expected は、それぞれの行に自分が最後に書き込んだ本文。
 *
 * - 行を消す変更は、行の本文が expected のままのときにだけ適用する。
 *   他の人がその行を書き換えていたら、その人の書いたものごと消してしまうので、行を残す。
 * - 行の本文を置き換える変更は、他の人がその行を書き換えていたら、自分の変更だけを文字単位で適用する(ADR-0022)。
 *   ただし、自分が置き換えた文字を他の人がすべて書き換えていたら、置き換える前の文字は戻さない。
 *   統合した本文が1行の長さの上限を超えるなら、その行は変えない。
 */
function applyKeepingOthers(
	document: readonly Line[],
	changes: readonly Change[],
	expected: ReadonlyMap<LineId, string>,
): readonly Line[] {
	const current = new Map(document.map((line) => [line.id, line.text]));
	const applicable = changes.flatMap((change): Change[] => {
		if (change.type === "delete") {
			return current.get(change.id) === expected.get(change.id) ? [change] : [];
		}
		if (change.type !== "update") return [change];
		const text = current.get(change.id);
		// 行がなくなっていたら、適用しても何も起きない。元にした本文がなければ、そのまま置き換える。
		if (text === undefined || change.base === undefined) return [change];
		const merged = mergeText(change.base, text, change.text, { mode: "yield" });
		// 他の人が書き足した分と合わせると、1行の長さの上限を超える。送れない行になるので、この行は変えない。
		if (merged.length > MAX_LINE_LENGTH) return [];
		return [{ type: "update", id: change.id, text: merged }];
	});
	return applyChanges(document, applicable).lines;
}

/**
 * 自分の編集を打ち消す(取り消し)。他の人の変更は巻き戻さない。
 * - 自分が書き換えた行: 書き換える前に戻す。他の人も書き換えていたら、自分の変更だけを打ち消す
 * - 自分が足した行: 本文が自分の書いたままなら、消す
 * - 自分が消した行: 同じ行IDで、元の位置(前後の行がなければ近い位置)に戻す
 * - 自分が動かした行: 元の位置に戻す
 * 対象の行がなくなっている変更は、何もしない。打ち消せる変更が1つもなければ、同じ文書を返す。
 */
export function revertEdit(document: readonly Line[], edit: OwnEdit): readonly Line[] {
	return applyKeepingOthers(document, edit.backward, writtenTexts(edit.forward));
}

/**
 * 打ち消した編集を、もう一度行う(やり直し)。
 * 打ち消したあとに他の人が書き換えた行には、その人の変更を残して行う。
 * 打ち消して戻した行を他の人が書き換えていたら、その行は消さない。
 */
export function reapplyEdit(document: readonly Line[], edit: OwnEdit): readonly Line[] {
	return applyKeepingOthers(document, edit.forward, writtenTexts(edit.backward));
}
