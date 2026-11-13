import { exports } from "cloudflare:workers";
import { MAX_TITLE_LENGTH } from "@amime/shared";
import {
	type PageId,
	parseClientId,
	parseCommitRequest,
	parsePageId,
	parsePageSort,
} from "@amime/sync";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

type AppEnv = { Bindings: Cloudflare.Env };

/** コミットの本文の大きさの上限(バイト)。 */
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;

/** 認証とプロジェクト(P4)が入るまで、プロジェクトは1つだけ。 */
const PROJECT = "default";

/** 削除されたページへの要求に返す本文。 */
const DELETED = { error: "page-deleted" };

/** プロジェクトのページの台帳。名前(タイトル)から、ページのIDを引く(ADR-0024)。 */
const directory = () => exports.ProjectDO.getByName(PROJECT);

/** ページの保存先。ページは、名前を変えても変わらないIDで識別する。 */
const pageStub = (id: PageId) => exports.PageDO.getByName(`${PROJECT}/${id}`);

/** Origin ヘッダーの指すサイトが、要求を受けたこのサイトと同じか(スキーム・ホスト・ポートがすべて同じ)。 */
function sameSite(origin: string, url: string): boolean {
	try {
		return new URL(origin).origin === new URL(url).origin;
	} catch {
		return false;
	}
}

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

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

/** ページの読み書き。 */
const pages = new Hono<AppEnv>()
	.use(async (c, next) => {
		// 認証(P4)が入るまで、公開環境ではページを読み書きできないようにする(ADR-0009、ADR-0017)。
		if (c.env.PAGE_API !== "enabled") return c.json({ error: "page-api-disabled" }, 403);
		// 他のサイトのページからの要求を断る。ブラウザは、他のサイトへの要求に Origin を付ける。
		// WebSocket は他のサイトからでも接続でき、書き込みも形式によっては送れてしまうので、ここで止める。
		const origin = c.req.header("origin");
		if (origin !== undefined && !sameSite(origin, c.req.url)) {
			return c.json({ error: "cross-origin" }, 403);
		}
		c.header("cache-control", "no-store");
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
		return c.json(await directory().list({ sort: sort.value, ...limit, ...offset }));
	})
	// 名前でページを探す(ADR-0029)。入力に合う名前を、合う順に返す。
	.get("/titles", async (c) => {
		const query = c.req.query("q") ?? "";
		const limit = countQuery(c.req.query("limit"), "limit");
		if (query.length > MAX_TITLE_LENGTH || limit === null) {
			return c.json({ error: "invalid-query" }, 400);
		}
		return c.json({ titles: await directory().titles(query, limit.limit) });
	})
	// 本文を探す(ADR-0031)。すべての語を本文に含むページを返す。
	.get("/search", async (c) => {
		const query = c.req.query("q") ?? "";
		const limit = countQuery(c.req.query("limit"), "limit");
		if (query.length > MAX_TITLE_LENGTH || limit === null) {
			return c.json({ error: "invalid-query" }, 400);
		}
		return c.json(await directory().search(query, limit.limit));
	})
	// 名前からページを引く。まだないページには、IDを決める(本文は、書き込まれるまで作られない)。
	.get("/by-title/:title", async (c) => {
		const title = c.req.param("title");
		if (title.length > MAX_TITLE_LENGTH) return c.json({ error: "invalid-page-name" }, 400);
		return c.json(await directory().open(title));
	})
	.get("/:id", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		const page = await pageStub(id.value).getPage();
		if (page !== "deleted") return c.json(page);
		// 削除が、本文を消したところで止まっていたら、台帳に残っている。ここで消して、同じ名前を使えるようにする。
		await directory().remove(id.value);
		return c.json(DELETED, 410);
	})
	// ページのつながり(関連するページ、同じリンクを持つページ、まだないページへのリンク)。ADR-0027。
	.get("/:id/links", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		return c.json(await directory().links(id.value));
	})
	// ページを削除する(ADR-0026)。本文を消してから、台帳から消す。何度呼んでも、結果は同じ。
	.delete("/:id", async (c) => {
		const id = parsePageId(c.req.param("id"));
		if (!id.ok) return c.json({ error: "invalid-page" }, 400);
		await pageStub(id.value).destroy();
		await directory().remove(id.value);
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
		const info = await directory().pin(id.value, pinned);
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
			const result = await pageStub(page.value).commit({ id, changes }, client);
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
		return pageStub(page.value).fetch(c.req.raw);
	});

/** HTTP API。パスはすべて /api 配下に置き、それ以外は静的アセット(SPA)が応答する。 */
export const app = new Hono<AppEnv>()
	.basePath("/api")
	.get("/health", (c) => c.json({ status: "ok" }))
	.route("/pages", pages)
	.notFound((c) => c.json({ error: "not-found" }, 404));
