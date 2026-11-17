import { err, MAX_TITLE_LENGTH, ok, type Result } from "@tsuzuri/shared";
import * as v from "valibot";
import { MAX_CHANGES, MAX_LINE_LENGTH } from "./schema.ts";
import type { Change, LineId } from "./types.ts";

/**
 * プロジェクトの書き出しファイルの形式(ADR-0043)。読み込むときに、このアプリのファイルかを見分ける。
 * 形を変えるときは、版を上げる。古い版のファイルは、読めるようにしておく。
 */
export const PROJECT_FILE_FORMAT = "tsuzuri-project";
export const PROJECT_FILE_VERSION = 1;

/** 書き出したページ。 */
export type ProjectFilePage = {
	/** ページの名前。1行目と同じ。 */
	readonly title: string;
	/** すべての行の本文。1行目が名前。 */
	readonly lines: readonly string[];
	/** 一覧の先頭に固定していたか。 */
	readonly pinned: boolean;
	/** 最初に開かれた時刻(ミリ秒)。記録のため。読み込んだページは、読み込んだ時刻に作ったものになる。 */
	readonly created: number;
	/** 最後に変更された時刻(ミリ秒)。記録のため。 */
	readonly updated: number;
};

/** プロジェクトの書き出しファイル。 */
export type ProjectFile = {
	readonly format: typeof PROJECT_FILE_FORMAT;
	readonly version: typeof PROJECT_FILE_VERSION;
	/** 書き出したプロジェクトの名前。記録のため(別の名前のプロジェクトにも読み込める)。 */
	readonly project: string;
	/** 書き出した時刻(ISO 8601)。 */
	readonly exportedAt: string;
	readonly pages: readonly ProjectFilePage[];
};

/** 書き出しファイルを作る。ページは、作った順(同じなら名前の順)に並べる。 */
export function buildProjectFile(
	project: string,
	pages: readonly ProjectFilePage[],
	exportedAt: number,
): ProjectFile {
	return {
		format: PROJECT_FILE_FORMAT,
		version: PROJECT_FILE_VERSION,
		project,
		exportedAt: new Date(exportedAt).toISOString(),
		pages: [...pages].sort((a, b) => a.created - b.created || (a.title < b.title ? -1 : 1)),
	};
}

const LINE = v.pipe(
	v.string(),
	v.maxLength(MAX_LINE_LENGTH),
	v.check((text: string) => !/[\r\n]/.test(text)),
);
const TIME = v.pipe(v.number(), v.minValue(0));

const PageSchema = v.pipe(
	v.object({
		title: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TITLE_LENGTH)),
		lines: v.pipe(v.array(LINE), v.minLength(1)),
		pinned: v.boolean(),
		created: TIME,
		updated: TIME,
	}),
	// 名前は1行目から決まる。違っていたら、読み込んだあとで、別の名前のページになってしまう。
	v.check((page) => page.lines[0] === page.title),
);

const ProjectFileSchema = v.object({
	format: v.literal(PROJECT_FILE_FORMAT),
	version: v.literal(PROJECT_FILE_VERSION),
	project: v.string(),
	exportedAt: v.string(),
	pages: v.array(PageSchema),
});

export type ProjectFileError =
	| "invalid-json"
	| "not-project-file"
	| "unsupported-version"
	| "invalid";

/**
 * 書き出しファイルを読む。
 * - JSON でない: invalid-json
 * - このアプリの形式でない: not-project-file
 * - 読めない版(新しい版): unsupported-version
 * - 形が違う(1ページでも): invalid。一部だけを読み込むと、どこまで復元したかが分かりにくくなる
 */
export function parseProjectFile(text: string): Result<ProjectFile, ProjectFileError> {
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		return err("invalid-json");
	}
	if (typeof input !== "object" || input === null || !("format" in input)) {
		return err("not-project-file");
	}
	if (input.format !== PROJECT_FILE_FORMAT) return err("not-project-file");
	if (!("version" in input) || input.version !== PROJECT_FILE_VERSION) {
		return err("unsupported-version");
	}
	const result = v.safeParse(ProjectFileSchema, input);
	return result.success ? ok(result.output) : err("invalid");
}

/**
 * 空のページに、lines を上から順に足すコミット(変更の列)。
 * 1回のコミットの変更の数には上限がある(MAX_CHANGES)ので、上限ごとに分ける。
 * 続きのコミットは、前のコミットの最後の行の後ろへ足す。
 */
export function insertionCommits(
	lines: readonly string[],
	createId: () => LineId,
	limit: number = MAX_CHANGES,
): Change[][] {
	const commits: Change[][] = [];
	let previous: LineId | null = null;
	for (const [index, text] of lines.entries()) {
		if (index % limit === 0) commits.push([]);
		const id = createId();
		commits.at(-1)?.push({ type: "insert", line: { id, text }, after: previous, before: null });
		previous = id;
	}
	return commits;
}
