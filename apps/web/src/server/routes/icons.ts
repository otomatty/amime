import { exports } from "cloudflare:workers";
import { MAX_TITLE_LENGTH, toTitleLc } from "@amime/shared";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { listMembers } from "../db/members.ts";

/**
 * `[名前.icon]` の画像(ADR-0035)。
 * その名前のページに画像があれば、その画像。なければ、その表示名のメンバーのアイコン。
 * プロジェクトを読めることは、手前で確かめてある(c.var.project)。
 */
export const icons = new Hono<AppEnv>().get("/:name", async (c) => {
	const name = c.req.param("name");
	if (name.length > MAX_TITLE_LENGTH) return c.json({ error: "invalid-name" }, 400);
	const { id } = c.var.project;
	const fromPage = await exports.ProjectDO.getByName(id).image(name);
	if (fromPage !== null) return c.json({ url: fromPage });
	// 名前は、ページの名前と同じ決まりで照らし合わせる(大文字と小文字、空白かアンダースコアかを区別しない)。
	const wanted = toTitleLc(name);
	const member = (await listMembers(c.env.DB, id)).find(
		(candidate) => candidate.picture !== null && toTitleLc(candidate.name) === wanted,
	);
	return member?.picture ? c.json({ url: member.picture }) : c.json({ error: "unknown-icon" }, 404);
});
