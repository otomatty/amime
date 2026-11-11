import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/server/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "amime",
		compatibilityDate: "2026-11-10",
		entrypoint,
		assets: {
			// クライアントはSPA。未知のパスは index.html を返し、/api だけ Worker が先に処理する。
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*"],
		},
		exports: {
			PageDO: exports.durableObject({ storage: "sqlite" }),
		},
		observability: { enabled: true },
	},
});
