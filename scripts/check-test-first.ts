/**
 * テスト先行の規約(docs/conventions.md「テスト」)を検査する。
 *
 * 使い方:
 *   node scripts/check-test-first.ts [比較元のGit参照]
 *
 * 比較元は 引数 > 環境変数 BASE_REF > origin/main の順で決まる。
 * 環境変数 COMMIT_HEADER(PRのタイトルなど)があれば、その種別でルール2も検査する。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseCommitType } from "./lib/commit-type.ts";
import { findViolations, type Violation } from "./lib/test-first.ts";

function git(...args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function describe(violation: Violation): string {
	switch (violation.rule) {
		case "missing-test":
			return `テストがありません: ${violation.file}\n    → ${violation.expected} を先に書いてください`;
		case "no-test-change":
			return `種別 "${violation.commitType}" の変更なのに、テストが1つも変更されていません:\n${violation.files.map((file) => `    ${file}`).join("\n")}\n    → 振る舞いの変更は、失敗するテストを先に追加してください。振る舞いを変えないなら種別を refactor にしてください`;
	}
}

const base = process.argv[2] ?? process.env["BASE_REF"] ?? "origin/main";
const header = process.env["COMMIT_HEADER"] ?? "";

// 追加(A)・変更(M)・改名(R)されたファイルだけを見る。削除はテスト不要。
const changedFiles = git("diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`)
	.split("\n")
	.filter(Boolean);

const violations = findViolations({
	changedFiles,
	fileExists: existsSync,
	commitType: parseCommitType(header),
});

if (violations.length > 0) {
	process.stderr.write(
		`テスト先行の規約違反が ${violations.length} 件あります。\n\n${violations.map((v) => `  ✗ ${describe(v)}`).join("\n\n")}\n`,
	);
	process.exit(1);
}

process.stdout.write(
	`テスト先行の規約: OK(${changedFiles.length} ファイルを確認、比較元 ${base})\n`,
);
