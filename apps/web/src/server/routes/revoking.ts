/** プロジェクトの台帳(ProjectDO)のうち、権限を取り上げたことを覚える部分。 */
type Directory = {
	revoke(subject: string): Promise<number>;
	settle(subject: string, pending: number): Promise<unknown>;
};

/**
 * 権限を取り上げる変更を行う。その相手(subject)がつないだままの接続を、閉じさせる(ADR-0034)。
 *
 * 変える前に、台帳に覚えさせる(覚えさせられなかったら、変えない)。このとき台帳は、少し先の時刻を覚えるので、
 * 変え終わるまでのあいだにつないだ接続も、閉じられる。変え終えたら、いまの時刻に直させる。
 * 直させるのに失敗しても、先の時刻が残るだけなので(その時刻までにつないだ接続が閉じられる)、変更は成り立たせる。
 */
export async function revoking<Result>(
	directories: readonly Directory[],
	subject: string,
	change: () => Promise<Result>,
): Promise<Result> {
	const pending = await Promise.all(directories.map((directory) => directory.revoke(subject)));
	try {
		return await change();
	} finally {
		await Promise.all(
			directories.map((directory, index) =>
				// 失敗は、無視する(上に書いたとおり、先の時刻が残る)。
				directory.settle(subject, pending[index] ?? 0).catch(() => {}),
			),
		);
	}
}
