import type { Result } from "@amime/shared";
import {
	type ClientId,
	type Commit,
	type PageId,
	type PageInfo,
	type PageLinks,
	type PageList,
	type PageSort,
	parseCommitResult,
	parsePageInfo,
	parsePageLinks,
	parsePageList,
	parsePageTitles,
	parseSnapshot,
} from "@amime/sync";
import { PageApiError } from "./page-api-error.ts";
import { connectPageSocket } from "./page-socket.ts";
import type { PageApi } from "./page-sync.ts";

const STATUS_FORBIDDEN = 403;
/** 削除されたページへの要求への応答。 */
const STATUS_GONE = 410;
/** 送った内容に問題があるときの応答(形が正しくない、大きすぎる)。 */
const STATUS_REJECTED: ReadonlySet<number | undefined> = new Set([400, 413]);

/** APIを呼ぶ。失敗はすべて PageApiError にする。 */
async function send(url: string, init: RequestInit | undefined): Promise<Response> {
	const response = await fetch(url, init).catch(() => null);
	if (response?.status === STATUS_FORBIDDEN) throw new PageApiError("disabled");
	if (response?.status === STATUS_GONE) throw new PageApiError("gone");
	if (STATUS_REJECTED.has(response?.status)) throw new PageApiError("rejected");
	if (!response?.ok) throw new PageApiError("failed");
	return response;
}

/** APIを呼び、応答の本文を検査して返す。失敗はすべて PageApiError にする。 */
async function request<T>(
	url: string,
	init: RequestInit | undefined,
	parse: (body: unknown) => Result<T, "invalid">,
): Promise<T> {
	const response = await send(url, init);

	const parsed = parse(await response.json().catch(() => null));
	if (!parsed.ok) throw new PageApiError("failed");
	return parsed.value;
}

const JSON_HEADERS = { "content-type": "application/json" };

const pagePath = (id: PageId): string => `/api/pages/${id}`;

/**
 * 名前(URLの中の名前)から、ページを引く(ADR-0024)。
 * まだないページには、サーバーがIDを決める。ページの本文は、書き込むまで作られない。
 */
export function openPage(name: string): Promise<PageInfo> {
	return request(`/api/pages/by-title/${encodeURIComponent(name)}`, undefined, parsePageInfo);
}

/** ページの一覧を取り出す(ADR-0025)。offset は、何件目から取り出すか。 */
export function listPages({
	sort,
	offset,
}: {
	readonly sort: PageSort;
	readonly offset: number;
}): Promise<PageList> {
	return request(`/api/pages?sort=${sort}&offset=${offset}`, undefined, parsePageList);
}

/** 名前でページを探す(ADR-0029)。入力に合う名前を、合う順に返す。入力が空なら、更新が新しい順。 */
export function searchTitles(query: string): Promise<readonly string[]> {
	return request(`/api/pages/titles?q=${encodeURIComponent(query)}`, undefined, parsePageTitles);
}

/** ページのつながり(関連するページ、同じリンクを持つページ、まだないページへのリンク)を取り出す。ADR-0027。 */
export function loadLinks(id: PageId): Promise<PageLinks> {
	return request(`${pagePath(id)}/links`, undefined, parsePageLinks);
}

/** ページを、一覧の先頭に固定する(pinned が false なら、固定を外す)。ADR-0026。 */
export function pinPage(id: PageId, pinned: boolean): Promise<PageInfo> {
	// 固定の指定は、形が決まっている。サーバーが断るのは、台帳にないページのときだけ。
	const init = { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ pinned }) };
	return request(`${pagePath(id)}/pin`, init, parsePageInfo).catch((error: unknown) => {
		throw error instanceof PageApiError && error.kind === "rejected"
			? new PageApiError("failed")
			: error;
	});
}

/** ページを削除する(ADR-0026)。元には戻せない。 */
export async function deletePage(id: PageId): Promise<void> {
	await send(pagePath(id), { method: "DELETE" });
}

/** ページの WebSocket のURL。いま開いているページ(location)と同じ接続先にする。 */
export function pageSocketUrl(location: URL | Location, id: PageId, client: ClientId): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}${pagePath(id)}/socket?client=${client}`;
}

/**
 * 指定したページを読み書きするAPI。ページは、名前を変えても変わらないIDで指す。
 * client は、この端末(タブ)の識別子。自分のコミットが、自分の WebSocket に配信されないようにするために送る。
 */
export function createPageApi(id: PageId, client: ClientId): PageApi {
	const url = pagePath(id);
	return {
		subscribe: (handlers) =>
			connectPageSocket({ url: pageSocketUrl(window.location, id, client), handlers }),
		load: () => request(url, undefined, parseSnapshot),
		commit: (commit: Commit) =>
			request(
				`${url}/commits`,
				{
					method: "POST",
					headers: JSON_HEADERS,
					body: JSON.stringify({ ...commit, client }),
				},
				parseCommitResult,
			),
	};
}
