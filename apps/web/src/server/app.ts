import { exports } from "cloudflare:workers";
import { toTitleLc } from "@amime/shared";
import { parseClientId, parseCommitRequest } from "@amime/sync";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

type AppEnv = { Bindings: Cloudflare.Env };

/** ページ名(タイトル)の長さの上限。 */
const MAX_PAGE_NAME_LENGTH = 200;
/** コミットの本文の大きさの上限(バイト)。 */
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;

/**
 * ページの保存先を返す。認証とプロジェクト(P4)が入るまで、プロジェクトは1つだけ。
 * ページは、正規化したタイトルで識別する(空白と大文字小文字の違いは同じページ)。
 */
const pageStub = (name: string) => exports.PageDO.getByName(`default/${toTitleLc(name)}`);

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
		c.header("cache-control", "no-store");
		return next();
	})
	.use("/:page/*", async (c, next) => {
		const name = c.req.param("page");
		if (name.length > MAX_PAGE_NAME_LENGTH) return c.json({ error: "invalid-page-name" }, 400);
		return next();
	})
	.get("/:page", async (c) => c.json(await pageStub(c.req.param("page")).getPage()))
	.post(
		"/:page/commits",
		bodyLimit({
			maxSize: MAX_COMMIT_BYTES,
			onError: (c) => c.json({ error: "commit-too-large" }, 413),
		}),
		async (c) => {
			const commit = parseCommitRequest(await readJson(c.req.raw));
			if (!commit.ok) return c.json({ error: "invalid-commit" }, 400);
			const { changes, client } = commit.value;
			return c.json(await pageStub(c.req.param("page")).commit(changes, client));
		},
	)
	// 他の端末のコミットを受け取るための WebSocket(ADR-0018)。
	.get("/:page/socket", async (c) => {
		// 検査は Worker の側で済ませ、正しい要求だけを Durable Object に渡す。
		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json({ error: "upgrade-required" }, 426);
		}
		if (!parseClientId(c.req.query("client")).ok) return c.json({ error: "invalid-client" }, 400);
		return pageStub(c.req.param("page")).fetch(c.req.raw);
	});

/** HTTP API。パスはすべて /api 配下に置き、それ以外は静的アセット(SPA)が応答する。 */
export const app = new Hono<AppEnv>()
	.basePath("/api")
	.get("/health", (c) => c.json({ status: "ok" }))
	.route("/pages", pages)
	.notFound((c) => c.json({ error: "not-found" }, 404));
