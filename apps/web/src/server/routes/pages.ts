import { exports } from "cloudflare:workers";
import { allows, MAX_TITLE_LENGTH } from "@amime/shared";
import {
	type PageId,
	parseClientId,
	parseCommitRequest,
	parsePageId,
	parsePageSort,
} from "@amime/sync";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, readJson } from "../context.ts";

/** コミットの本文の大きさの上限(バイト)。 */
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;

/** 削除されたページへの要求に返す本文。 */
const DELETED = { error: "page-deleted" };

/** プロジェクトのページの台帳。名前(タイトル)から、ページのIDを引く(ADR-0024)。 */
const directory = (c: Context<AppEnv>) => exports.ProjectDO.getByName(c.var.project.id);

/** ページの保存先。ページは、名前を変えても変わらないIDで識別する。 */
const pageStub = (c: Context<AppEnv>, id: PageId) =>
	exports.PageDO.getByName(`${c.var.project.id}/${id}`);

/** このプロジェクトに、書き込めるか(メンバーか)。 */
const canWrite = (c: Context<AppEnv>) =>
	allows(c.var.project.role, c.var.project.visibility, "write");

/** 台帳にないページを指す要求に返す本文。 */
const UNKNOWN_PAGE = { error: "unknown-page" };

/**
 * そのIDのページを、読ませてよいか。書き込めない人には、台帳にあるページだけを読ませる
 * (でたらめなIDを指して、ページの保存先を作らせない)。メンバーは、これから書くページも読める。
 */
const readable = async (c: Context<AppEnv>, id: PageId): Promise<boolean> =>
	canWrite(c) || (await directory(c).has(id));

/** 0以上の整数の問い合わせ。 */
const COUNT = /^\d{1,9}$/;

/**
 * 件数や始まりの位置の問い合わせを読む。省かれていれば空、形が違えば null。
 * 返したものを、そのまま一覧の指定に展開できる形にする。
 */
function countQuery(
	value: string | undefined,
	key: "limit" | "offset",
): Partial<Record<"limit" | "offset", number>> | null {
	if (value === undefined) return {};
	return COUNT.test(value) ? { [key]: Number(value) } : null;
}

/**
 * プロジェクトのページの読み書き。
 * 読めること(メンバーか、公開のプロジェクトか)は、手前で確かめてある(c.var.project)。
 */
export const pages = new Hono<AppEnv>()
	.use(async (c, next) => {
		// 読むだけの要求(GET)のほかは、メンバーだけが送れる(ADR-0033)。
		if (c.req.method !== "GET" && !canWrite(c)) return c.json({ error: "read-only" }, 403);
		return next();
	})
	// ページの一覧(ADR-0025)。
	.get("/", async (c) => {
		const sort = parsePageSort(c.req.query("sort") ?? "updated");
		const limit = countQuery(c.req.query("limit"), "limit");
		const offset = countQuery(c.req.query("offset"), "offset");
		if (!sort.ok || limit === null || offset === null) {
			return c.json({ error: "invalid-query" }, 400);
		}
		return c.json(await directory(c).list({ sort: sort.value, ...limit, ...offset }));
	})
	// 名前でページを探す(ADR-0029)。入力に合う名前を、合う順に返す。
	.get("/titles", async (c) => {
		const query = c.req.query("q") ?? "";
		const limit = countQuery(c.req.query("limit"), "limit");
		if (query.length > MAX_TITLE_LENGTH || limit === null) {
			return c.json({ error: "invalid-query" }, 400);
		}
		return c.json({ titles: await directory(c).titles(query, limit.limit) });
	})
	// 本文を探す(ADR-0031)。すべての語を本文に含むページを返す。
	.get("/search", async (c) => {
		const query = c.req.query("q") ?? "";
		const limit = countQuery(c.req.query("limit"), "limit");
		if (query.length > MAX_TITLE_LENGTH || limit === null) {
			return c.json({ error: "invalid-query" }, 400);
		}
		return c.json(await directory(c).search(query, limit.limit));
	})
	// 名前からページを引く。まだないページには、IDを決める(本文は、書き込まれるまで作られない)。
	.get("/by-title/:title", async (c) => {
		const title = c.req.param("title");
		if (title.length > MAX_TITLE_LENGTH) return c.json({ error: "invalid-page-name" }, 400);
		// 書き込めない人が開いても、台帳にページを増やさない。
		const info = canWrite(c) ? await directory(c).open(title) : await directory(c).find(title);
		return info === null ? c.json(UNKNOWN_PAGE, 404) : c.json(info);
	})
	.get("/:id", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		if (!(await readable(c, id.value))) return c.json(UNKNOWN_PAGE, 404);
		const page = await pageStub(c, id.value).getPage();
		if (page !== "deleted") return c.json(page);
		// 削除が、本文を消したところで止まっていたら、台帳に残っている。ここで消して、同じ名前を使えるようにする。
		await directory(c).remove(id.value);
		return c.json(DELETED, 410);
	})
	// ページのつながり(関連するページ、同じリンクを持つページ、まだないページへのリンク)。ADR-0027。
	.get("/:id/links", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		if (!(await readable(c, id.value))) return c.json(UNKNOWN_PAGE, 404);
		return c.json(await directory(c).links(id.value));
	})
	// ページを削除する(ADR-0026)。本文を消してから、台帳から消す。何度呼んでも、結果は同じ。
	.delete("/:id", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		await pageStub(c, id.value).destroy();
		await directory(c).remove(id.value);
		return c.body(null, 204);
	})
	// ページを、一覧の先頭に固定する・固定を外す(ADR-0026)。
	.put("/:id/pin", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		const body = await readJson(c.req.raw);
		const pinned =
			typeof body === "object" && body !== null && "pinned" in body ? body.pinned : null;
		if (typeof pinned !== "boolean") return c.json({ error: "invalid-pin" }, 400);
		const info = await directory(c).pin(id.value, pinned);
		return info === null ? c.json({ error: "unknown-page" }, 404) : c.json(info);
	})
	.post(
		"/:id/commits",
		bodyLimit({
			maxSize: MAX_COMMIT_BYTES,
			onError: (c) => c.json({ error: "commit-too-large" }, 413),
		}),
		async (c) => {
			const page = parsePageId(c.req.param("id"));
			if (!page.ok) return c.json({ error: "invalid-page" }, 400);
			const commit = parseCommitRequest(await readJson(c.req.raw));
			if (!commit.ok) return c.json({ error: "invalid-commit" }, 400);
			const { id, changes, client } = commit.value;
			const result = await pageStub(c, page.value).commit({ id, changes }, client);
			return result === "deleted" ? c.json(DELETED, 410) : c.json(result);
		},
	)
	// 他の端末のコミットを受け取るための WebSocket(ADR-0018)。
	.get("/:id/socket", async (c) => {
		// 検査は Worker の側で済ませ、正しい要求だけを Durable Object に渡す。
		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json({ error: "upgrade-required" }, 426);
		}
		const page = parsePageId(c.req.param("id"));
		if (!page.ok) return c.json({ error: "invalid-page" }, 400);
		if (!parseClientId(c.req.query("client")).ok) return c.json({ error: "invalid-client" }, 400);
		if (!(await readable(c, page.value))) return c.json(UNKNOWN_PAGE, 404);
		// 読むだけの人の接続には、印を付ける(カーソルの位置を、他の人に配らない)。
		// 印は、ここで付け直す。要求に付いてきたものは、使わない。
		const url = new URL(c.req.url);
		url.searchParams.set("access", canWrite(c) ? "write" : "read");
		// 権限を確かめ始めた時刻も、付ける。確かめたあと、接続を受け付けるまでのあいだに権限がなくなっても、
		// この時刻で比べれば、閉じられる。
		url.searchParams.set("at", String(c.var.authorizedAt));
		// だれの接続かも、ここで付ける(権限がなくなったときに、その人の接続を閉じるため)。
		url.searchParams.set("user", c.var.user?.id ?? "");
		// ログインの状態が切れる時刻も、付ける(切れたあとは、変更を配らない)。
		url.searchParams.set("expires", String(c.var.sessionExpires ?? ""));
		return pageStub(c, page.value).fetch(new Request(url, c.req.raw));
	});
