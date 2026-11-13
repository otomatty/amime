import { err, ok, type Result, type Role, type Visibility } from "@amime/shared";
import * as v from "valibot";

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

const ProjectInfoSchema = v.object({
	name: v.string(),
	visibility: v.picklist(["public", "private"]),
	role: v.nullable(v.picklist(["admin", "member"])),
});
const ProjectListSchema = v.object({
	projects: v.array(ProjectInfoSchema),
	canCreate: v.boolean(),
});

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
