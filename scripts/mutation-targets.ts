/**
 * PRで変えたファイルから、ミューテーションテストの対象を選び、カンマ区切りで出す(ADR-0041)。
 * 対象がなければ、何も出さない。
 *
 * 使い方:
 *   node scripts/mutation-targets.ts [比較元のGit参照]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mutationTargets } from "./lib/mutation.ts";

const base = process.argv[2] ?? process.env["BASE_REF"] ?? "origin/main";
const changed = execFileSync(
	"git",
	["diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`],
	{
		encoding: "utf8",
	},
)
	.split("\n")
	.filter(Boolean);

// テストだけを変えたとき、対応する実装ファイルがないこともある(テスト用の補助など)。あるものだけにする。
const targets = mutationTargets(changed).filter((file) => existsSync(file));
process.stdout.write(targets.join(","));
