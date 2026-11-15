/**
 * Stryker の結果(reports/mutation/mutation.json)を表にまとめる(ADR-0041)。
 * 環境変数 GITHUB_STEP_SUMMARY があれば、ジョブの概要にも書く。合否は Stryker が決める(STRYKER_BREAK)。
 *
 * 使い方:
 *   node scripts/mutation-report.ts [結果のJSON]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { formatMutationReport, scoreMutationReport } from "./lib/mutation.ts";

const path = process.argv[2] ?? "reports/mutation/mutation.json";
const breakAt = Number(process.env["STRYKER_BREAK"] ?? 90);
const report = formatMutationReport(
	scoreMutationReport(JSON.parse(readFileSync(path, "utf8"))),
	breakAt,
);

process.stdout.write(`${report}\n`);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) appendFileSync(summary, `### ミューテーションテスト\n\n${report}\n`);
