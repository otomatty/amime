import { describe, expect, it } from "vitest";
import { formatMutationReport, mutationTargets, scoreMutationReport } from "./mutation.ts";

describe("mutationTargets(PRで変えたファイルから、ミューテーションテストの対象を選ぶ)", () => {
	it("パッケージの実装ファイルを選ぶ", () => {
		expect(
			mutationTargets([
				"packages/parser/src/line.ts",
				"packages/sync/src/merge-text.ts",
				"apps/web/src/client/app/app.tsx",
				"docs/adr/0041-mutation-testing.md",
			]),
		).toEqual(["packages/parser/src/line.ts", "packages/sync/src/merge-text.ts"]);
	});

	it("テストだけを変えたときは、そのテストが確かめる実装ファイルを選ぶ", () => {
		expect(mutationTargets(["packages/sync/src/merge-text.test.ts"])).toEqual([
			"packages/sync/src/merge-text.ts",
		]);
	});

	it("実装とテストの両方を変えても、1つにまとめる。順は名前順", () => {
		expect(
			mutationTargets([
				"packages/sync/src/merge-text.test.ts",
				"packages/parser/src/line.ts",
				"packages/sync/src/merge-text.ts",
			]),
		).toEqual(["packages/parser/src/line.ts", "packages/sync/src/merge-text.ts"]);
	});

	it("振る舞いを持たないファイル(index.ts、types.ts、*.types.ts、*.d.ts)は選ばない", () => {
		expect(
			mutationTargets([
				"packages/parser/src/index.ts",
				"packages/parser/src/types.ts",
				"packages/sync/src/change.types.ts",
				"packages/shared/src/env.d.ts",
			]),
		).toEqual([]);
	});

	it("パッケージの src の外(設定ファイルなど)は選ばない", () => {
		expect(
			mutationTargets(["packages/parser/package.json", "packages/parser/vitest.config.ts"]),
		).toEqual([]);
	});
});

const mutants = (...statuses: string[]) => ({ mutants: statuses.map((status) => ({ status })) });

describe("scoreMutationReport(Stryker の結果から、ファイルごとの点を出す)", () => {
	it("点は、見つけた変異(Killed と Timeout)の割合。見つけられなかったもの(Survived と NoCoverage)が分母に入る", () => {
		const scores = scoreMutationReport({
			files: {
				"packages/a/src/x.ts": mutants("Killed", "Killed", "Timeout", "Survived", "NoCoverage"),
			},
		});

		expect(scores.files).toEqual([
			{ file: "packages/a/src/x.ts", detected: 3, undetected: 2, score: 60 },
		]);
		expect(scores.total).toEqual({ detected: 3, undetected: 2, score: 60 });
	});

	it("コンパイルや実行の誤り、無視したものは、数えない", () => {
		const scores = scoreMutationReport({
			files: {
				"packages/a/src/x.ts": mutants("Killed", "CompileError", "RuntimeError", "Ignored"),
			},
		});

		expect(scores.total).toEqual({ detected: 1, undetected: 0, score: 100 });
	});

	it("ファイルは、点の低い順に並べる。全体は、すべてのファイルを合わせて計る", () => {
		const scores = scoreMutationReport({
			files: {
				"packages/a/src/good.ts": mutants("Killed", "Killed", "Killed", "Killed"),
				"packages/a/src/weak.ts": mutants("Killed", "Survived"),
			},
		});

		expect(scores.files.map((file) => file.file)).toEqual([
			"packages/a/src/weak.ts",
			"packages/a/src/good.ts",
		]);
		expect(scores.total.score).toBeCloseTo(83.33, 2);
	});

	it("数えられる変異が1つもないファイルは、点を null にして、最後に並べる", () => {
		const scores = scoreMutationReport({
			files: {
				"packages/a/src/empty.ts": mutants("CompileError"),
				"packages/a/src/x.ts": mutants("Survived"),
			},
		});

		expect(scores.files).toEqual([
			{ file: "packages/a/src/x.ts", detected: 0, undetected: 1, score: 0 },
			{ file: "packages/a/src/empty.ts", detected: 0, undetected: 0, score: null },
		]);
	});

	it("ファイルがなければ、全体の点も null", () => {
		expect(scoreMutationReport({ files: {} }).total).toEqual({
			detected: 0,
			undetected: 0,
			score: null,
		});
	});
});

describe("formatMutationReport(ジョブの概要に出す表)", () => {
	it("全体の点と下限、ファイルごとの点を、Markdown の表にする", () => {
		const report = formatMutationReport(
			scoreMutationReport({
				files: {
					"packages/a/src/good.ts": mutants("Killed", "Killed"),
					"packages/a/src/weak.ts": mutants("Killed", "Survived", "Survived"),
					"packages/a/src/empty.ts": mutants("CompileError"),
				},
			}),
			80,
		);

		expect(report).toBe(
			[
				"全体: **60.0**(下限 80)❌",
				"",
				"| ファイル | 見つけた | 見逃した | 点 |",
				"| --- | ---: | ---: | ---: |",
				"| packages/a/src/weak.ts | 1 | 2 | 33.3 |",
				"| packages/a/src/good.ts | 2 | 0 | 100.0 |",
				"| packages/a/src/empty.ts | 0 | 0 | - |",
			].join("\n"),
		);
	});

	it("下限以上なら ✅", () => {
		const report = formatMutationReport(
			scoreMutationReport({ files: { "packages/a/src/x.ts": mutants("Killed") } }),
			90,
		);

		expect(report.split("\n")[0]).toBe("全体: **100.0**(下限 90)✅");
	});

	it("全体の点が出せないときは、そのことを書く", () => {
		expect(formatMutationReport(scoreMutationReport({ files: {} }), 90).split("\n")[0]).toBe(
			"全体: **-**(下限 90)対象の変異がありません",
		);
	});
});
