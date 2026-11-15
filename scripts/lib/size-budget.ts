/** 配信するファイルの大きさの上限。ビルドの出力(Worker の出力ディレクトリ)からの相対パスで、対象を選ぶ。 */
export interface Budget {
	readonly name: string;
	readonly pattern: RegExp;
	readonly maxGzipBytes: number;
}

export interface MeasuredFile {
	readonly path: string;
	readonly gzipBytes: number;
}

export interface BudgetResult {
	readonly name: string;
	readonly files: number;
	readonly gzipBytes: number;
	readonly maxGzipBytes: number;
	readonly ok: boolean;
}

/**
 * 上限ごとに、当てはまるファイルの大きさ(gzip)を足して比べる。
 * 当てはまるファイルが1つもないときは、ビルドの出力が変わって検査が空振りしているので、失敗にする。
 */
export function checkBudgets(
	files: readonly MeasuredFile[],
	budgets: readonly Budget[],
): BudgetResult[] {
	return budgets.map((budget) => {
		const matched = files.filter((file) => budget.pattern.test(file.path));
		const gzipBytes = matched.reduce((sum, file) => sum + file.gzipBytes, 0);
		return {
			name: budget.name,
			files: matched.length,
			gzipBytes,
			maxGzipBytes: budget.maxGzipBytes,
			ok: matched.length > 0 && gzipBytes <= budget.maxGzipBytes,
		};
	});
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

function verdict(result: BudgetResult): string {
	if (result.files === 0) return "❌ ファイルがない";
	return result.ok ? "✅" : "❌ 超過";
}

/** 結果を Markdown の表にする(ジョブの概要と、ログに出す)。 */
export function formatReport(results: readonly BudgetResult[]): string {
	return [
		"| 対象 | ファイル数 | 大きさ(gzip) | 上限 | 結果 |",
		"| --- | ---: | ---: | ---: | --- |",
		...results.map(
			(result) =>
				`| ${result.name} | ${result.files} | ${kib(result.gzipBytes)} | ${kib(result.maxGzipBytes)} | ${verdict(result)} |`,
		),
	].join("\n");
}
