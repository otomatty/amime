import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const isCI = Boolean(process.env["CI"]);

/** 本番ビルド(SPA + Worker)をローカルの Workers ランタイムで起動し、ブラウザから検証する。 */
export default defineConfig({
	testDir: "./tests",
	forbidOnly: isCI,
	retries: isCI ? 1 : 0,
	reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		locale: "ja-JP",
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// 事前に `pnpm build` が必要。CI ではビルド成果物を受け取ってから起動する。
		command: `pnpm --filter @amime/web preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/api/health`,
		reuseExistingServer: !isCI,
		timeout: 60_000,
	},
});
