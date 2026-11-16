import { defineConfig } from "vitest/config";

/** ミューテーションテスト(Stryker)で使う設定。純粋パッケージのテストだけを動かす(stryker.config.js)。 */
export default defineConfig({
	test: {
		// projects に分けると、下の testTimeout が各パッケージに引き継がれない。1つの設定で、パッケージのテストを直接選ぶ。
		include: ["packages/*/src/**/*.test.ts"],
		// Stryker は、テストごとに通った箇所を計るための計測を、実装に埋め込む。そのぶんテストが遅くなる。
		// ふだん 0.8 秒かかるテスト(sync の changes.test.ts の、統合の上限を確かめるもの)が、
		// CI で4つのプロセスを並べたときに、既定の 5 秒を超えた(2026-11-16 の定期実行)。
		// 変異の時間切れは、Stryker が別に判定する(timeoutMS)ので、ここでは十分に長くする。
		testTimeout: 60_000,
	},
});
