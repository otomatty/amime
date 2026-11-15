/** ミューテーションテスト(Stryker)の対象の選び方と、結果のまとめ方(ADR-0041)。 */

const PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.+\.ts$/;
/** 振る舞いを持たないファイル。カバレッジの対象外と同じ(vitest.config.ts)。 */
const NO_BEHAVIOR = /(^|\/)(index|types)\.ts$|\.types\.ts$|\.d\.ts$/;
const TEST_FILE = /\.test\.ts$/;

/**
 * PRで変えたファイルから、変異を入れるファイルを選ぶ。
 * テストだけを変えたときも、そのテストが確かめる実装ファイルを選ぶ(テストを弱めていないかを見るため)。
 */
export function mutationTargets(changedFiles: readonly string[]): string[] {
	const targets = changedFiles
		.filter((file) => PACKAGE_SOURCE.test(file))
		.map((file) => file.replace(TEST_FILE, ".ts"))
		.filter((file) => !NO_BEHAVIOR.test(file));
	return [...new Set(targets)].sort();
}

interface MutationReport {
	readonly files: Readonly<
		Record<string, { readonly mutants: readonly { readonly status: string }[] }>
	>;
}

interface Tally {
	readonly detected: number;
	readonly undetected: number;
	/** 0〜100。数えられる変異が1つもなければ null。 */
	readonly score: number | null;
}

interface FileScore extends Tally {
	readonly file: string;
}

export interface MutationScores {
	readonly files: readonly FileScore[];
	readonly total: Tally;
}

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

function tally(statuses: readonly string[]): Tally {
	const detected = statuses.filter((status) => DETECTED.has(status)).length;
	const undetected = statuses.filter((status) => UNDETECTED.has(status)).length;
	const counted = detected + undetected;
	return { detected, undetected, score: counted === 0 ? null : (detected / counted) * 100 };
}

/** Stryker の JSON の結果から、ファイルごとと全体の点を出す。ファイルは、点の低い順(点のないものは最後)。 */
export function scoreMutationReport(report: MutationReport): MutationScores {
	const entries = Object.entries(report.files);
	const files = entries
		.map(([file, { mutants }]) => ({ file, ...tally(mutants.map((mutant) => mutant.status)) }))
		.sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY));
	const total = tally(entries.flatMap(([, { mutants }]) => mutants.map((mutant) => mutant.status)));
	return { files, total };
}

const points = (score: number | null) => (score === null ? "-" : score.toFixed(1));

function verdict(score: number | null, breakAt: number): string {
	if (score === null) return "対象の変異がありません";
	return score >= breakAt ? "✅" : "❌";
}

/** ジョブの概要に出す表。 */
export function formatMutationReport(scores: MutationScores, breakAt: number): string {
	return [
		`全体: **${points(scores.total.score)}**(下限 ${breakAt})${verdict(scores.total.score, breakAt)}`,
		"",
		"| ファイル | 見つけた | 見逃した | 点 |",
		"| --- | ---: | ---: | ---: |",
		...scores.files.map(
			(file) => `| ${file.file} | ${file.detected} | ${file.undetected} | ${points(file.score)} |`,
		),
	].join("\n");
}
