import { err, ok, type Result } from "@amime/shared";
import * as v from "valibot";
import type { Change, CommitResult, LineId, PageSnapshot } from "./types.ts";

/** 1行の本文の長さの上限(UTF-16 の符号単位)。 */
export const MAX_LINE_LENGTH = 20_000;
/** 1つのコミットに入れられる変更の数の上限。 */
export const MAX_CHANGES = 2_000;

const LINE_ID = /^[\w-]{1,64}$/;
const LINE_BREAK = /[\r\n]/;

// 行IDは外部から届く文字列。形を検査したうえで、ここでブランド型にする。
const LineIdSchema = v.pipe(
	v.string(),
	v.regex(LINE_ID),
	v.transform((value) => value as LineId),
);
const TextSchema = v.pipe(
	v.string(),
	v.maxLength(MAX_LINE_LENGTH),
	v.check((value) => !LINE_BREAK.test(value)),
);
const LineSchema = v.object({ id: LineIdSchema, text: TextSchema });
const placement = { after: v.nullable(LineIdSchema), before: v.nullable(LineIdSchema) };

const ChangeSchema = v.variant("type", [
	v.object({ type: v.literal("insert"), line: LineSchema, ...placement }),
	v.object({ type: v.literal("update"), id: LineIdSchema, text: TextSchema }),
	v.object({ type: v.literal("delete"), id: LineIdSchema }),
	v.object({ type: v.literal("move"), id: LineIdSchema, ...placement }),
]);
const ChangesSchema = v.pipe(v.array(ChangeSchema), v.maxLength(MAX_CHANGES));
const VersionSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const SnapshotSchema = v.object({ version: VersionSchema, lines: v.array(LineSchema) });
const CommitResultSchema = v.object({ version: VersionSchema, applied: v.array(ChangeSchema) });

function parse<T>(schema: v.GenericSchema<unknown, T>, input: unknown): Result<T, "invalid"> {
	const result = v.safeParse(schema, input);
	return result.success ? ok(result.output) : err("invalid");
}

/** 外部から届いた変更の列(コミットの中身)を検査する。 */
export const parseChanges = (input: unknown): Result<readonly Change[], "invalid"> =>
	parse(ChangesSchema, input);

/** サーバーから届いたページを検査する。 */
export const parseSnapshot = (input: unknown): Result<PageSnapshot, "invalid"> =>
	parse(SnapshotSchema, input);

/** サーバーから届いた、コミットへの応答を検査する。 */
export const parseCommitResult = (input: unknown): Result<CommitResult, "invalid"> =>
	parse(CommitResultSchema, input);
