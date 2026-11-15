import { defineConfig } from "vitest/config";

/** ミューテーションテスト(Stryker)で使う設定。純粋パッケージのテストだけを動かす(stryker.config.json)。 */
export default defineConfig({
	test: {
		projects: ["packages/*"],
	},
});
