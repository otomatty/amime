import { invariant } from "./invariant.ts";

/** 配列の指定した位置の要素を返す。範囲外なら不変条件違反(呼び出し側が範囲内だと分かっているときに使う)。 */
export function itemAt<T>(items: readonly T[], index: number): T {
	const item = items[index];
	invariant(item !== undefined, `index ${index} is out of range`);
	return item;
}
