/** プロジェクトの台帳(ProjectDO)のうち、権限を取り上げたことを覚える部分。 */
type Directory = {
	revoke(subject: string): Promise<number>;
	settle(subject: string, operation: number, applied: boolean): Promise<unknown>;
};

/**
 * 権限を取り上げる変更を行う。その相手(subject)がつないだままの接続を、閉じさせる(ADR-0034)。
 *
 * 変える前に、台帳に覚えさせる(覚えさせられなかったら、変えない)。台帳は、取り上げている途中のあいだ、
 * 少し先の時刻までにつないだ接続を閉じさせるので、変え終わるまでのあいだにつないだ接続も、閉じられる。
 * 変え終えたら、台帳に知らせる(変えたなら、いまの時刻に直る。applied が false を返したら、取り上げなかったことになる)。
 * 知らせるのに失敗しても、先の時刻が残るだけなので(その時刻までにつないだ接続が閉じられる)、変更は成り立たせる。
 */
export async function revoking<Result>(
	directories: readonly Directory[],
	subject: string,
	change: () => Promise<Result>,
	/** 変更の結果から、権限を変えたかを決める。 */
	applied: (result: Result) => boolean,
): Promise<Result> {
	const started = await Promise.allSettled(
		directories.map((directory) => directory.revoke(subject)),
	);
	const settle = (changed: boolean) =>
		Promise.all(
			started.map((operation, index) =>
				operation.status === "fulfilled"
					? // 失敗は、無視する(上に書いたとおり、先の時刻が残る)。
						directories[index]?.settle(subject, operation.value, changed).catch(() => {})
					: null,
			),
		);
	const failed = started.find((operation) => operation.status === "rejected");
	if (failed !== undefined) {
		// 覚えさせられなかった台帳がある。権限は変えないので、覚えさせられた台帳には、取り上げなかったことを知らせる。
		await settle(false);
		throw failed.reason;
	}
	let result: Result;
	try {
		result = await change();
	} catch (error) {
		// 変わったかどうか、分からない。変わったものとして、閉じさせる。
		await settle(true);
		throw error;
	}
	await settle(applied(result));
	return result;
}
