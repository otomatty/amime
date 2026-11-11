/** 呼び出し側のバグでしか起こり得ない状態を表す。捕捉して回復する対象ではない。 */
export class InvariantError extends Error {
	override readonly name = "InvariantError";
}

/** 不変条件を検証する。想定内の失敗には使わず、Result を返すこと。 */
export function invariant(condition: boolean, message: string): asserts condition {
	if (!condition) throw new InvariantError(message);
}
