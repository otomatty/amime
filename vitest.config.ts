import { defineConfig } from "vitest/config";

/**
 * Node 上で動くテスト(純粋パッケージ、クライアント、リポジトリ用スクリプト)の設定。
 * Workers ランタイム上で動かすサーバーのテストは apps/web/vitest.server.config.ts にある。
 */
export default defineConfig({
	test: {
		projects: ["packages/*", "apps/web/vitest.client.config.ts", "scripts"],
		coverage: {
			provider: "v8",
			reporter: ["text-summary", "html", "lcov"],
			include: [
				"packages/*/src/**/*.ts",
				"apps/web/src/client/**/*.{ts,tsx}",
				"scripts/lib/**/*.ts",
			],
			exclude: ["**/*.test.{ts,tsx}", "**/index.ts", "**/types.ts", "**/main.tsx", "**/*.d.ts"],
			thresholds: {
				// 純粋パッケージは仕様そのものなので、未検証のコードを許さない。
				"{packages/*/src,scripts/lib}/**/*.ts": {
					statements: 100,
					branches: 100,
					functions: 100,
					lines: 100,
				},
				"apps/web/src/client/**/*.{ts,tsx}": {
					statements: 80,
					branches: 80,
					functions: 80,
					lines: 80,
				},
			},
		},
	},
});
