import { err, ok, type Result, type Role, type Visibility } from "@amime/shared";
import * as v from "valibot";
import type { UserId } from "./account.ts";

/** プロジェクトと、それを見ている人の役割。 */
export type ProjectInfo = {
	/** 名前。URLの最初の部分になる。 */
	readonly name: string;
	readonly visibility: Visibility;
	/** 見ている人の役割。メンバーでなければ null(公開のプロジェクトを、読むだけ)。 */
	readonly role: Role | null;
};

/** 参加しているプロジェクトの一覧。 */
export type ProjectList = {
	readonly projects: readonly ProjectInfo[];
	/** 新しいプロジェクトを作れるか。 */
	readonly canCreate: boolean;
};

/** プロジェクトのメンバー。 */
export type Member = {
	readonly id: UserId;
	readonly name: string;
	/** アイコンの画像のURL。なければ null。 */
	readonly picture: string | null;
	readonly role: Role;
	/** 参加した時刻。 */
	readonly joined: number;
};

/** まだ使える招待リンク(リンクに入れた値は、作ったときにしか分からない)。 */
export type Invite = {
	readonly id: string;
	readonly created: number;
	/** 使えなくなる時刻。 */
	readonly expires: number;
};

/** 作ったばかりの招待リンク。token は、リンクに入れる値。 */
export type NewInvite = Invite & { readonly token: string };

/** プロジェクトのメンバーと、まだ使える招待リンク。招待リンクは、管理者にだけ返る(ほかの人には、空)。 */
export type ProjectMembers = {
	readonly members: readonly Member[];
	readonly invites: readonly Invite[];
};

/** 招待リンクの招待先。member は、見ている人が、もうメンバーか。 */
export type InviteTarget = { readonly project: string; readonly member: boolean };

const ProjectInfoSchema = v.object({
	name: v.string(),
	visibility: v.picklist(["public", "private"]),
	role: v.nullable(v.picklist(["admin", "member"])),
});
const ProjectListSchema = v.object({
	projects: v.array(ProjectInfoSchema),
	canCreate: v.boolean(),
});

const Id = v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/));
const Time = v.pipe(v.number(), v.integer(), v.minValue(0));
const InviteSchema = v.object({ id: Id, created: Time, expires: Time });
const NewInviteSchema = v.object({ ...InviteSchema.entries, token: Id });
const ProjectMembersSchema = v.object({
	members: v.array(
		v.object({
			id: v.pipe(
				Id,
				v.transform((value) => value as UserId),
			),
			name: v.string(),
			picture: v.nullable(v.string()),
			role: v.picklist(["admin", "member"]),
			joined: Time,
		}),
	),
	invites: v.array(InviteSchema),
});
const InviteTargetSchema = v.object({ project: v.string(), member: v.boolean() });

function parse<T>(schema: v.GenericSchema<unknown, T>, input: unknown): Result<T, "invalid"> {
	const parsed = v.safeParse(schema, input);
	return parsed.success ? ok(parsed.output) : err("invalid");
}

/** サーバーから届いた、プロジェクトの情報を検査する。 */
export const parseProjectInfo = (input: unknown): Result<ProjectInfo, "invalid"> =>
	parse(ProjectInfoSchema, input);

/** サーバーから届いた、参加しているプロジェクトの一覧を検査する。 */
export const parseProjectList = (input: unknown): Result<ProjectList, "invalid"> =>
	parse(ProjectListSchema, input);

/** サーバーから届いた、メンバーと招待リンクの一覧を検査する。 */
export const parseProjectMembers = (input: unknown): Result<ProjectMembers, "invalid"> =>
	parse(ProjectMembersSchema, input);

/** サーバーから届いた、作ったばかりの招待リンクを検査する。 */
export const parseNewInvite = (input: unknown): Result<NewInvite, "invalid"> =>
	parse(NewInviteSchema, input);

/** サーバーから届いた、招待リンクの招待先を検査する。 */
export const parseInviteTarget = (input: unknown): Result<InviteTarget, "invalid"> =>
	parse(InviteTargetSchema, input);
