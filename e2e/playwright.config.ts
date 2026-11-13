import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const isCI = Boolean(process.env["CI"]);
/** ブラウザをダウンロードできない環境で、手元の Chromium を使うための指定。 */
const chromiumPath = process.env["E2E_CHROMIUM_PATH"];

/** メンバーとしてログインした状態(Cookie)の置き場所。 */
export const MEMBER_STATE = ".auth/member.json";

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
	projects: [
		// 先に、メンバーとしてログインし、E2E用のプロジェクトを用意する(tests/auth.setup.ts)。
		{ name: "setup", testMatch: /auth\.setup\.ts/ },
		{
			name: "chromium",
			dependencies: ["setup"],
			use: {
				...devices["Desktop Chrome"],
				// テストは、E2E用のプロジェクトのメンバーとしてログインした状態から始める。
				storageState: MEMBER_STATE,
				...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
			},
		},
	],
	webServer: {
		// 事前に E2E 用のビルド(`pnpm build:e2e`)が必要。`pnpm test:e2e` が先に実行する。
		// E2E用のビルドでは、開発用のログインが使える(ADR-0032)。本番用のビルドでは、使えない。
		command: `pnpm --filter @amime/web preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/api/health`,
		reuseExistingServer: !isCI,
		timeout: 60_000,
	},
});
