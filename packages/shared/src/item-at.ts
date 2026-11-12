import { invariant } from "./invariant.ts";

/**
 * 配列の指定した位置の要素を返す。範囲外なら不変条件違反(呼び出し側が範囲内だと分かっているときに使う)。
 * 範囲外かどうかを要素が undefined かどうかで判定するので、undefined を要素に持つ配列には使えない(型で禁じている)。
 */
export function itemAt<T extends NonNullable<unknown> | null>(
	items: readonly T[],
	index: number,
): T {
	const item = items[index];
	invariant(item !== undefined, `index ${index} is out of range`);
	return item;
}
