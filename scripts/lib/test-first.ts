export type Violation =
	| { readonly rule: "missing-test"; readonly file: string; readonly expected: string }
	| { readonly rule: "no-test-change"; readonly commitType: string; readonly files: string[] };

type Input = {
	/** 今回の変更で追加・変更されたファイル(リポジトリのルートからの相対パス)。 */
	readonly changedFiles: readonly string[];
	readonly fileExists: (path: string) => boolean;
	/** Conventional Commits の種別。不明なら undefined。 */
	readonly commitType: string | undefined;
};

/** テストを書く対象になる場所。 */
const SOURCE_ROOT = /^(?:packages\/[^/]+\/src|apps\/[^/]+\/src|scripts\/lib)\//;
const TYPESCRIPT = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
/** 振る舞いを持たない、または起動時にしか動かないためテスト対象外にするファイル。 */
const EXEMPT = /(?:^|\/)(?:index\.ts|types\.ts|main\.tsx|[^/]+\.types\.ts|[^/]+\.d\.ts)$/;

/** テストの変更を必須にするコミット種別。振る舞いが変わる変更だけを対象にする。 */
const BEHAVIOR_CHANGING_TYPES = new Set(["feat", "fix"]);

function isSource(file: string): boolean {
	return (
		SOURCE_ROOT.test(file) && TYPESCRIPT.test(file) && !TEST_FILE.test(file) && !EXEMPT.test(file)
	);
}

function testPathFor(file: string): string {
	return file.replace(TYPESCRIPT, (extension) => `.test${extension}`);
}

/**
 * テスト先行の規約に違反している箇所を返す。
 * ルール1: 変更した実装ファイルの隣に、対応するテストファイルが存在すること。
 * ルール2: feat / fix の変更は、テストファイルの変更を少なくとも1つ含むこと。
 */
export function findViolations({ changedFiles, fileExists, commitType }: Input): Violation[] {
	const sources = changedFiles.filter(isSource);

	const violations: Violation[] = sources
		.map((file) => ({ file, expected: testPathFor(file) }))
		.filter(({ expected }) => !fileExists(expected))
		.map(({ file, expected }) => ({ rule: "missing-test", file, expected }));

	const changesBehavior = commitType !== undefined && BEHAVIOR_CHANGING_TYPES.has(commitType);
	const changedTests = changedFiles.some((file) => TEST_FILE.test(file));
	if (changesBehavior && sources.length > 0 && !changedTests) {
		violations.push({ rule: "no-test-change", commitType, files: sources });
	}

	return violations;
}
