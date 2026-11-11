import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** サーバー(Worker と Durable Object)のテスト。Workers ランタイム(workerd)上で実行する。 */
export default defineConfig({
	plugins: [cloudflareTest({ config: true })],
	test: {
		name: "@amime/web:server",
		include: ["src/server/**/*.test.ts"],
	},
});
