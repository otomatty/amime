import { err, MAX_TITLE_LENGTH, ok, type Result, titleOfLine, toTitleLc } from "@tsuzuri/shared";
import * as v from "valibot";
import { MAX_LINE_LENGTH } from "./schema.ts";
import { splitChanges } from "./session.ts";
import type { Change, Line, LineId } from "./types.ts";

/**
 * プロジェクトの書き出しファイルの形式(ADR-0043)。読み込むときに、このアプリのファイルかを見分ける。
 * 形を変えるときは、版を上げる。古い版のファイルは、読めるようにしておく。
 */
export const PROJECT_FILE_FORMAT = "tsuzuri-project";
export const PROJECT_FILE_VERSION = 1;

/** 書き出したページ。 */
export type ProjectFilePage = {
	/**
	 * ページの名前(台帳の名前)。ふつうは1行目と同じ。1行目が空、長すぎる、ほかのページと同じ名前の
	 * ときは、名前は元のまま残るので、1行目と違うことがある(ADR-0024)。
	 */
	readonly title: string;
	/** すべての行の本文。 */
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

const PageSchema = v.object({
	title: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TITLE_LENGTH)),
	lines: v.pipe(v.array(LINE), v.minLength(1)),
	pinned: v.boolean(),
	created: TIME,
	updated: TIME,
});

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
 * 名前と1行目が違うページ(page)の1行目を名前に持つ、ファイルの中のページ。なければ null。
 * page の1行目を戻す前に、このページが台帳に載っている(保存されている)必要がある。まだ載っていなければ、
 * 台帳は、その名前を空いているものとして扱い、page に名前を取らせてしまう。
 */
export function firstLineHolder(file: ProjectFile, page: ProjectFilePage): ProjectFilePage | null {
	const wanted = toTitleLc(titleOfLine(page.lines.slice(0, 1).join("")));
	if (wanted === toTitleLc(page.title)) return null;
	return file.pages.find((other) => toTitleLc(other.title) === wanted) ?? null;
}

/** 文字列の 32 ビットの FNV-1a。seed で、別の値の列にする。 */
function fnv1a(text: string, seed: number): number {
	let hash = seed;
	for (let index = 0; index < text.length; index += 1) {
		hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
	}
	return hash;
}

/**
 * 読み込むページの行ID。同じファイルの同じページなら、いつも同じ ID にする。
 * やり直したときに、途中まで読み込んだページを見分けられ(planPageImport)、
 * 2人が同じファイルを同時に読み込んでも、同じ ID の行は1つしか入らない(同じ ID の行を足す変更は、何もしない)。
 */
export function importLineIds(file: ProjectFile, page: ProjectFilePage): LineId[] {
	const key = `${file.project}\n${file.exportedAt}\n${page.title}`;
	const tag = `${fnv1a(key, 0x811c9dc5).toString(36)}${fnv1a(key, 0x050c5d1f).toString(36)}`;
	return page.lines.map((_, index) => `i${tag}-${index.toString(36)}` as LineId);
}

/** いまのページ(名前で開いたページ)の状態。 */
export type ImportTarget = {
	readonly version: number;
	readonly lines: readonly Line[];
	readonly pinned: boolean;
};

/**
 * 1つのページの読み込み。
 * - commits: 行を足すコミット(変更の列)。1行目は、いったん名前にしておく
 * - pin: 固定するか
 * - firstLine: 1行目を、元の本文に戻す変更。すべてのページの commits を送ったあとで送る。戻さなくてよければ null
 */
export type PageImport = {
	readonly commits: readonly (readonly Change[])[];
	readonly pin: boolean;
	readonly firstLine: Change | null;
};

/**
 * 1つのページを、どう読み込むか。書き換えてはいけないページなら null(飛ばす)。
 * - まだないページ(開いただけ): すべての行を、上から順に、前の行の後ろへ足す
 * - 前の読み込みが途中で止まったページ(行IDと本文が、読み込む行の先頭と同じ): 続きだけを行う
 * - それ以外(同じ名前の、ほかのページ): 書き換えない
 * 行は、1回のコミットに収まる大きさ(変更の数と本文の長さ)ごとに分ける。
 *
 * 名前と1行目が違うページ(1行目が空、長すぎる、ほかのページの名前)は、1行目を名前にして作り、
 * すべてのページを作ったあとで、1行目を元に戻す(firstLine)。台帳は、行を足したページの名前を1行目に合わせ、
 * そのとき、まだ行のないページの名前は空いているものとして扱う。1行目から作ると、ほかのページの名前を取ってしまう。
 * 先にすべてのページが自分の名前を持てば、1行目を戻しても、ほかのページの名前は取られない(元のプロジェクトと同じ)。
 */
export function planPageImport(
	page: ProjectFilePage,
	ids: readonly LineId[],
	target: ImportTarget,
): PageImport | null {
	const lines = page.lines.map((text, index): Line => ({ id: ids[index] as LineId, text }));
	// 1行目を名前にした行。
	const staged = lines.map((line, index) => (index === 0 ? { ...line, text: page.title } : line));
	if (target.lines.length === 0 && target.version > 0) return null;
	if (target.lines.length > lines.length) return null;
	const resumable = target.lines.every(
		(line, index) =>
			line.id === lines[index]?.id &&
			(line.text === staged[index]?.text || line.text === lines[index]?.text),
	);
	if (!resumable) return null;
	let previous = target.lines.at(-1)?.id ?? null;
	const changes = staged.slice(target.lines.length).map((line): Change => {
		const change: Change = { type: "insert", line, after: previous, before: null };
		previous = line.id;
		return change;
	});
	const pin = page.pinned && !target.pinned;
	const first = target.lines[0]?.text ?? page.title;
	const original = page.lines.slice(0, 1).join("");
	const firstLine: Change | null =
		first === original
			? null
			: { type: "update", id: ids[0] as LineId, text: original, base: first };
	if (changes.length === 0 && !pin && firstLine === null) return null;
	return { commits: splitChanges(changes), pin, firstLine };
}
