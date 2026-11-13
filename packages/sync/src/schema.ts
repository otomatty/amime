import { err, ok, type Result } from "@amime/shared";
import * as v from "valibot";
import type {
	ClientId,
	CommitId,
	CommitRequest,
	CommitResult,
	LineId,
	PageSnapshot,
	PendingRecord,
	ServerMessage,
} from "./types.ts";

/** 1行の本文の長さの上限(UTF-16 の符号単位)。 */
export const MAX_LINE_LENGTH = 20_000;
/** 1つのコミットに入れられる変更の数の上限。 */
export const MAX_CHANGES = 2_000;
/**
 * クライアントが1つのコミットに入れる本文の長さの合計の目安(UTF-16 の符号単位)。
 * これを超える変更は、複数のコミットに分けて送る。JSONにしたときに、サーバーが受け付ける大きさに収めるため。
 */
export const MAX_COMMIT_TEXT_LENGTH = 300_000;

/** 行IDと、端末の識別子に使える形。 */
const IDENTIFIER = /^[\w-]{1,64}$/;
const LINE_BREAK = /[\r\n]/;

// 行IDは外部から届く文字列。形を検査したうえで、ここでブランド型にする。
const LineIdSchema = v.pipe(
	v.string(),
	v.regex(IDENTIFIER),
	v.transform((value) => value as LineId),
);
const placement = { after: v.nullable(LineIdSchema), before: v.nullable(LineIdSchema) };

/** 本文の検査を指定して、変更の検査を作る。 */
const changeSchema = <Text extends v.GenericSchema<unknown, string>>(text: Text) =>
	v.variant("type", [
		v.object({
			type: v.literal("insert"),
			line: v.object({ id: LineIdSchema, text }),
			...placement,
		}),
		// base は、この変更が元にした本文(ADR-0022)。本文と同じ検査をする。
		v.object({ type: v.literal("update"), id: LineIdSchema, text, base: v.optional(text) }),
		v.object({ type: v.literal("delete"), id: LineIdSchema }),
		v.object({ type: v.literal("move"), id: LineIdSchema, ...placement }),
	]);

const noLineBreak = v.check((value: string) => !LINE_BREAK.test(value));
const TextSchema = v.pipe(v.string(), v.maxLength(MAX_LINE_LENGTH), noLineBreak);
const LineSchema = v.object({ id: LineIdSchema, text: TextSchema });
const ChangeSchema = changeSchema(TextSchema);
/**
 * 端末内に残した変更。本文の長さは制限しない。
 * 編集欄は長さを制限していないので、送れない長さの行も残してあることがある。復元して、直してもらう。
 */
const StoredChangeSchema = changeSchema(v.pipe(v.string(), noLineBreak));
const ChangesSchema = v.pipe(v.array(ChangeSchema), v.maxLength(MAX_CHANGES));
const VersionSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const SnapshotSchema = v.object({ version: VersionSchema, lines: v.array(LineSchema) });
const commitResult = { version: VersionSchema, applied: v.array(ChangeSchema) };
const CommitResultSchema = v.object({ ...commitResult, duplicate: v.optional(v.boolean()) });
// コミットのIDも外部から届く文字列。形を検査したうえで、ここでブランド型にする。
const CommitIdSchema = v.pipe(
	v.string(),
	v.regex(IDENTIFIER),
	v.transform((value) => value as CommitId),
);
// 端末の識別子も外部から届く文字列。形を検査したうえで、ここでブランド型にする。
const ClientIdSchema = v.pipe(
	v.string(),
	v.regex(IDENTIFIER),
	v.transform((value) => value as ClientId),
);
const CommitRequestSchema = v.object({
	id: CommitIdSchema,
	changes: ChangesSchema,
	client: v.optional(ClientIdSchema),
});
// 変更の数と本文の長さに上限は設けない(送るときに、サーバーが検査する)。
const StoredChangesSchema = v.array(StoredChangeSchema);
const PendingRecordSchema = v.object({
	savedAt: v.pipe(v.number(), v.minValue(0)),
	entries: v.array(
		v.object({
			inflight: v.nullable(v.object({ id: CommitIdSchema, changes: StoredChangesSchema })),
			changes: StoredChangesSchema,
		}),
	),
});
const ServerMessageSchema = v.variant("type", [
	v.object({ type: v.literal("hello"), version: VersionSchema }),
	v.object({ type: v.literal("commit"), ...commitResult }),
]);

function parse<T>(schema: v.GenericSchema<unknown, T>, input: unknown): Result<T, "invalid"> {
	const result = v.safeParse(schema, input);
	return result.success ? ok(result.output) : err("invalid");
}

/** 外部から届いたコミット(変更の列と、送った端末の識別子)を検査する。 */
export const parseCommitRequest = (input: unknown): Result<CommitRequest, "invalid"> =>
	parse(CommitRequestSchema, input);

/** 外部から届いた端末の識別子を検査する。 */
export const parseClientId = (input: unknown): Result<ClientId, "invalid"> =>
	parse(ClientIdSchema, input);

/** JSONの文字列として届いたものを、読み取ってから検査する。 */
function parseJson<T>(schema: v.GenericSchema<unknown, T>, input: unknown): Result<T, "invalid"> {
	if (typeof input !== "string") return err("invalid");
	try {
		return parse(schema, JSON.parse(input));
	} catch {
		return err("invalid");
	}
}

/** サーバーから WebSocket で届いたメッセージを検査する。 */
export const parseServerMessage = (input: unknown): Result<ServerMessage, "invalid"> =>
	parseJson(ServerMessageSchema, input);

/** 端末内に残してあった未送信の変更を検査する。 */
export const parsePendingRecord = (input: unknown): Result<PendingRecord, "invalid"> =>
	parseJson(PendingRecordSchema, input);

/** サーバーから届いたページを検査する。 */
export const parseSnapshot = (input: unknown): Result<PageSnapshot, "invalid"> =>
	parse(SnapshotSchema, input);

/** サーバーから届いた、コミットへの応答を検査する。 */
export const parseCommitResult = (input: unknown): Result<CommitResult, "invalid"> =>
	parse(CommitResultSchema, input);
