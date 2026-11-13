import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/server/index.ts" with { type: "cf-worker" };

/**
 * 開発用のログイン(名前を入れるだけでログインできる)を有効にし、プロジェクトを誰でも作れるようにするモード。
 * 手元での開発と自動テストに限る。ここにないモード(production、プレビュー環境、指定なし)では無効になる。
 */
const DEV_LOGIN_MODES: ReadonlySet<string | undefined> = new Set(["development", "test", "e2e"]);

export default defineConfig(({ mode }) => ({
	worker: {
		name: "amime",
		compatibilityDate: "2026-11-10",
		entrypoint,
		assets: {
			// クライアントはSPA。未知のパスは index.html を返し、/api だけ Worker が先に処理する。
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*"],
		},
		env: {
			// 利用者とログインの状態(ADR-0032)。
			DB: bindings.d1({ name: "amime" }),
			// Google でのログインに使う、OAuth クライアントのIDとシークレット。自動テストでは、決まった値を使う。
			GOOGLE_CLIENT_ID: mode === "test" ? bindings.text("test-client-id") : bindings.secret(),
			GOOGLE_CLIENT_SECRET:
				mode === "test" ? bindings.text("test-client-secret") : bindings.secret(),
			DEV_LOGIN: bindings.text(DEV_LOGIN_MODES.has(mode) ? "enabled" : "disabled"),
			// プロジェクトを新しく作ってよい人(メールアドレスをカンマで並べる。「*」は、ログインしていれば誰でも)。
			// 手元での開発と自動テストでは、誰でも作れる。公開環境では、シークレットで渡す(なければ、誰も作れない)。
			PROJECT_CREATORS: DEV_LOGIN_MODES.has(mode) ? bindings.text("*") : bindings.secret(),
		},
		exports: {
			PageDO: exports.durableObject({ storage: "sqlite" }),
			ProjectDO: exports.durableObject({ storage: "sqlite" }),
		},
		observability: { enabled: true },
	},
}));
