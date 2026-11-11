import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** クライアント(React)のテスト。Node 上の仮想DOMで実行する。 */
export default defineConfig({
	plugins: [react()],
	test: {
		name: "@amime/web:client",
		environment: "jsdom",
		setupFiles: ["./vitest.client.setup.ts"],
		restoreMocks: true,
		include: ["src/client/**/*.test.{ts,tsx}"],
	},
});
