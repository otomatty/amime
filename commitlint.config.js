/** コミットとPRタイトルの規約。docs/conventions.md「コミットとPR」を参照。 */
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// 件名は日本語で書くので、英字の大文字小文字の規則は適用しない。
		"subject-case": [0],
		"scope-enum": [
			2,
			"always",
			["shared", "parser", "editor-core", "sync", "web", "e2e", "ci", "docs", "deps", "repo"],
		],
	},
};
