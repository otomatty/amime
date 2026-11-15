import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const isCI = Boolean(process.env["CI"]);
/** ブラウザをダウンロードできない環境で、手元の Chromium を使うための指定。 */
const chromiumPath = process.env["E2E_CHROMIUM_PATH"];

const chromiumLaunch = chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {};

/** Chromium でしか動かせないテストの印(テストの tag)。 */
const CHROMIUM_ONLY = /@chromium/;
/** Firefox では動かさないテストの印。理由は、テストの横に書く。 */
const NOT_FIREFOX = /@chromium|@not-firefox/;
/** スマートフォンの設定で動かすテスト。 */
const MOBILE_TESTS = /(smoke|layout|a11y|pages)\.spec\.ts/;

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
		// テストは、E2E用のプロジェクトのメンバーとしてログインした状態から始める。
		{
			name: "chromium",
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], storageState: MEMBER_STATE, ...chromiumLaunch },
		},
		// Chromium の機能(開発者ツール用の通信、クリップボードを読む許可)を使うテストには @chromium を付け、ほかでは動かさない。
		{
			name: "firefox",
			dependencies: ["setup"],
			grepInvert: NOT_FIREFOX,
			use: { ...devices["Desktop Firefox"], storageState: MEMBER_STATE },
		},
		{
			name: "webkit",
			dependencies: ["setup"],
			grepInvert: CHROMIUM_ONLY,
			use: { ...devices["Desktop Safari"], storageState: MEMBER_STATE },
		},
		// スマートフォン(画面の幅、タッチ、拡大率)。画面の作りと、主な画面を確かめるテストだけを動かす。
		{
			name: "mobile-chrome",
			dependencies: ["setup"],
			testMatch: MOBILE_TESTS,
			grepInvert: CHROMIUM_ONLY,
			use: { ...devices["Pixel 7"], storageState: MEMBER_STATE, ...chromiumLaunch },
		},
		{
			name: "mobile-safari",
			dependencies: ["setup"],
			testMatch: MOBILE_TESTS,
			grepInvert: CHROMIUM_ONLY,
			use: { ...devices["iPhone 15"], storageState: MEMBER_STATE },
		},
	],
	webServer: {
		// 事前に E2E 用のビルド(`pnpm build:e2e`)が必要。`pnpm test:e2e` が先に実行する。
		// E2E用のビルドでは、開発用のログインが使える(ADR-0032)。本番用のビルドでは、使えない。
		command: `pnpm --filter @tsuzuri/web preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/api/health`,
		reuseExistingServer: !isCI,
		timeout: 60_000,
	},
});
