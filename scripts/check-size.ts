/**
 * 配信するファイルの大きさ(gzip)が、上限を超えていないかを検査する。`pnpm build` のあとに動かす。
 *
 * 使い方:
 *   node scripts/check-size.ts [ビルドの出力ディレクトリ]
 *
 * 結果は表にして出す。環境変数 GITHUB_STEP_SUMMARY があれば、ジョブの概要にも書く。
 * 上限を変えるときは、理由を PR に書く(docs/adr/0039-quality-gates-in-ci.md)。
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { type Budget, checkBudgets, formatReport, type MeasuredFile } from "./lib/size-budget.ts";

const KIB = 1024;

/** いまの大きさに、4割ほどの余裕を持たせた値(2026-11-15 時点: JS 96.9 KiB、CSS 4.2 KiB、Worker 68.2 KiB)。 */
const BUDGETS: Budget[] = [
	{ name: "画面のJS", pattern: /^assets\/assets\/[^/]+\.js$/, maxGzipBytes: 140 * KIB },
	{ name: "画面のCSS", pattern: /^assets\/assets\/[^/]+\.css$/, maxGzipBytes: 12 * KIB },
	// Workers の上限(無料プランで圧縮後 3MB)より、ずっと手前に置く。大きいほど、起動が遅くなる。
	{ name: "Worker", pattern: /^bundle\/index\.js$/, maxGzipBytes: 256 * KIB },
];

const root = process.argv[2] ?? "apps/web/.cloudflare/output/v1/workers/default";

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

const files: MeasuredFile[] = walk(root).map((path) => ({
	path: relative(root, path).split(sep).join("/"),
	gzipBytes: gzipSync(readFileSync(path), { level: 9 }).byteLength,
}));

const results = checkBudgets(files, BUDGETS);
const report = formatReport(results);
process.stdout.write(`${report}\n`);

const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) appendFileSync(summary, `### 配信するファイルの大きさ\n\n${report}\n`);

if (results.some((result) => !result.ok)) {
	process.stderr.write("\n大きさの上限を超えたか、対象のファイルが見つかりません。\n");
	process.exitCode = 1;
}
