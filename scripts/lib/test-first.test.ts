import { describe, expect, it } from "vitest";
import { findViolations } from "./test-first.ts";

const check = (changed: string[], existing: string[], commitType?: string) =>
	findViolations({
		changedFiles: changed,
		fileExists: (path) => existing.includes(path),
		commitType,
	});

describe("findViolations", () => {
	describe("ルール1: 実装ファイルには隣にテストファイルが必要", () => {
		it("隣にテストがあれば違反なし", () => {
			const files = ["packages/parser/src/indent.ts", "packages/parser/src/indent.test.ts"];
			expect(check(files, files)).toEqual([]);
		});

		it("隣にテストがなければ missing-test", () => {
			expect(check(["packages/parser/src/link.ts"], [])).toEqual([
				{
					rule: "missing-test",
					file: "packages/parser/src/link.ts",
					expected: "packages/parser/src/link.test.ts",
				},
			]);
		});

		it("tsx のテストは tsx で探す", () => {
			expect(check(["apps/web/src/client/features/page/line-view.tsx"], [])).toEqual([
				{
					rule: "missing-test",
					file: "apps/web/src/client/features/page/line-view.tsx",
					expected: "apps/web/src/client/features/page/line-view.test.tsx",
				},
			]);
		});

		it("既存のテストは今回の変更に含まれていなくてもよい(リファクタリングを妨げない)", () => {
			expect(
				check(["packages/parser/src/indent.ts"], ["packages/parser/src/indent.test.ts"]),
			).toEqual([]);
		});

		it.each([
			["バレル", "packages/parser/src/index.ts"],
			["型だけのファイル", "packages/sync/src/types.ts"],
			["型だけのファイル(接尾辞)", "packages/sync/src/protocol.types.ts"],
			["型定義", "apps/web/src/client/env.d.ts"],
			["クライアントの起動コード", "apps/web/src/client/main.tsx"],
			["テスト自身", "packages/parser/src/indent.test.ts"],
			["src の外", "apps/web/vite.config.ts"],
			["TypeScript 以外", "apps/web/src/client/app/app.css"],
			["ドキュメント", "docs/conventions.md"],
		])("%sは対象外", (_name, file) => {
			expect(check([file], [])).toEqual([]);
		});

		it("scripts/lib も対象", () => {
			expect(check(["scripts/lib/foo.ts"], [])).toEqual([
				{ rule: "missing-test", file: "scripts/lib/foo.ts", expected: "scripts/lib/foo.test.ts" },
			]);
		});
	});

	describe("ルール2: feat / fix はテストの変更を伴う", () => {
		const source = "packages/parser/src/indent.ts";
		const test = "packages/parser/src/indent.test.ts";

		it.each(["feat", "fix"])("%s で実装だけを変更したら no-test-change", (commitType) => {
			expect(check([source], [test], commitType)).toEqual([
				{ rule: "no-test-change", commitType, files: [source] },
			]);
		});

		it("テストも変更していれば違反なし", () => {
			expect(check([source, test], [test], "feat")).toEqual([]);
		});

		it.each(["refactor", "perf", "chore", "docs", "style", "test", "ci", "build"])(
			"%s はテストの変更を要求しない",
			(commitType) => {
				expect(check([source], [test], commitType)).toEqual([]);
			},
		);

		it("実装ファイルを変更していない feat は対象外", () => {
			expect(check(["docs/conventions.md"], [], "feat")).toEqual([]);
		});

		it("コミット種別が不明ならルール2は適用しない", () => {
			expect(check([source], [test])).toEqual([]);
		});
	});
});
