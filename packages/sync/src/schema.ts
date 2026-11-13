import { err, ok, type Result } from "@amime/shared";
import * as v from "valibot";
import type {
	ClientId,
	ClientMessage,
	CommitId,
	CommitRequest,
	CommitResult,
	CursorPosition,
	LineId,
	PageId,
	PageInfo,
	PageLinks,
	PageList,
	PageSnapshot,
	PageSort,
	PendingRecord,
	SearchResults,
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
			origin: v.optional(ClientIdSchema),
			inflight: v.nullable(v.object({ id: CommitIdSchema, changes: StoredChangesSchema })),
			changes: StoredChangesSchema,
		}),
	),
});
// ページのIDも外部から届く文字列。形を検査したうえで、ここでブランド型にする。
const PageIdSchema = v.pipe(
	v.string(),
	v.regex(IDENTIFIER),
	v.transform((value) => value as PageId),
);
const pageTitle = {
	title: v.string(),
	problem: v.nullable(v.picklist(["taken", "empty", "too-long", "reserved"])),
};
const PageTitleSchema = v.object(pageTitle);
const PageInfoSchema = v.object({ id: PageIdSchema, ...pageTitle, pinned: v.boolean() });
const TimeSchema = v.pipe(v.number(), v.minValue(0));
const PageCardSchema = v.object({
	id: PageIdSchema,
	title: v.string(),
	descriptions: v.array(v.string()),
	image: v.nullable(v.string()),
	updated: TimeSchema,
	created: TimeSchema,
	linked: VersionSchema,
	pinned: v.boolean(),
});
const PageListSchema = v.object({ pages: v.array(PageCardSchema), total: VersionSchema });
const PageLinksSchema = v.object({
	missing: v.array(v.string()),
	related: v.array(PageCardSchema),
	hops: v.array(
		v.object({ title: v.string(), exists: v.boolean(), pages: v.array(PageCardSchema) }),
	),
});
const PageSortSchema = v.picklist(["updated", "created", "title", "linked"]);
const CursorSchema = v.nullable(
	v.object({
		line: LineIdSchema,
		column: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_LINE_LENGTH)),
	}),
);
const ClientMessageSchema = v.object({ type: v.literal("cursor"), cursor: CursorSchema });
const ServerMessageSchema = v.variant("type", [
	v.object({ type: v.literal("hello"), version: VersionSchema }),
	v.object({ type: v.literal("commit"), ...commitResult }),
	v.object({
		type: v.literal("cursor"),
		client: ClientIdSchema,
		cursor: CursorSchema,
		name: v.optional(v.string()),
	}),
	v.object({ type: v.literal("leave"), client: ClientIdSchema }),
	v.object({ type: v.literal("page"), ...pageTitle }),
	v.object({ type: v.literal("deleted") }),
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

/** 外部から届いたページのIDを検査する。 */
export const parsePageId = (input: unknown): Result<PageId, "invalid"> =>
	parse(PageIdSchema, input);

/** ページの名前と、名前を1行目に合わせられない理由を検査する。 */
export const parsePageTitle = (
	input: unknown,
): Result<Pick<PageInfo, "title" | "problem">, "invalid"> => parse(PageTitleSchema, input);

/** サーバーから届いた、ページの情報を検査する。 */
export const parsePageInfo = (input: unknown): Result<PageInfo, "invalid"> =>
	parse(PageInfoSchema, input);

const SearchResultsSchema = v.object({
	hits: v.array(
		v.object({
			id: PageIdSchema,
			title: v.string(),
			updated: TimeSchema,
			lines: v.array(v.string()),
		}),
	),
	more: v.boolean(),
});

/** サーバーから届いた、本文を探した結果を検査する。 */
export const parseSearchResults = (input: unknown): Result<SearchResults, "invalid"> =>
	parse(SearchResultsSchema, input);

const PageTitlesSchema = v.pipe(
	v.object({ titles: v.array(v.string()) }),
	v.transform(({ titles }): readonly string[] => titles),
);

/** サーバーから届いた、ページの名前の並び(名前で探した結果)を検査する。 */
export const parsePageTitles = (input: unknown): Result<readonly string[], "invalid"> =>
	parse(PageTitlesSchema, input);

/** サーバーから届いた、ページのつながりを検査する。 */
export const parsePageLinks = (input: unknown): Result<PageLinks, "invalid"> =>
	parse(PageLinksSchema, input);

/** サーバーから届いた、ページの一覧を検査する。 */
export const parsePageList = (input: unknown): Result<PageList, "invalid"> =>
	parse(PageListSchema, input);

/** 外部から届いた、一覧の並び順を検査する。 */
export const parsePageSort = (input: unknown): Result<PageSort, "invalid"> =>
	parse(PageSortSchema, input);

/** クライアントから WebSocket で届いたメッセージを検査する。 */
export const parseClientMessage = (input: unknown): Result<ClientMessage, "invalid"> =>
	parseJson(ClientMessageSchema, input);

/** カーソルの位置(出していなければ null)を検査する。 */
export const parseCursorPosition = (input: unknown): Result<CursorPosition | null, "invalid"> =>
	parse(CursorSchema, input);

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
