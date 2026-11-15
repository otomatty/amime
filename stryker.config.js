/**
 * ミューテーションテスト(Stryker)の設定(ADR-0041)。純粋パッケージの実装に変異を入れ、テストが見つけるかを確かめる。
 *
 * 環境変数:
 *   STRYKER_MUTATE  変異を入れるファイル(カンマ区切り)。なければ、すべてのパッケージ
 *   STRYKER_BREAK   これより点が低ければ失敗にする(既定 90)
 */
const targets = process.env["STRYKER_MUTATE"];

export default {
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { configFile: "vitest.mutation.config.ts" },
	// 振る舞いを持たないファイルは、カバレッジと同じく対象外にする(vitest.config.ts)。
	mutate: targets
		? targets.split(",")
		: [
				"packages/*/src/**/*.ts",
				"!**/*.test.ts",
				"!**/index.ts",
				"!**/types.ts",
				"!**/*.types.ts",
				"!**/*.d.ts",
			],
	coverageAnalysis: "perTest",
	thresholds: { high: 95, low: 90, break: Number(process.env["STRYKER_BREAK"] ?? 90) },
	reporters: ["clear-text", "progress", "html", "json"],
	htmlReporter: { fileName: "reports/mutation/index.html" },
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	tempDirName: ".stryker-tmp",
	cleanTempDir: "always",
};
