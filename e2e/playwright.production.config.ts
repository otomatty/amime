import { defineConfig, devices } from "@playwright/test";

/**
 * 本番へ出したあとの確認(ADR-0041)。環境変数 APP_URL の画面を、ログインせずに開く。
 * 手元のサーバーは立てない。Deploy のワークフローが動かす。
 */
const baseURL = process.env["APP_URL"];
if (!baseURL)
	throw new Error("APP_URL を指定してください(例: https://tsuzuri.example.workers.dev)");
const chromiumPath = process.env["E2E_CHROMIUM_PATH"];

export default defineConfig({
	testDir: "./production",
	forbidOnly: Boolean(process.env["CI"]),
	// 出した直後は、応えが遅いことがある。
	retries: 2,
	reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
	use: {
		baseURL,
		locale: "ja-JP",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
			},
		},
	],
});
