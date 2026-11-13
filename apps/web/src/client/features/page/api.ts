import type { Result } from "@amime/shared";
import {
	type ClientId,
	type Commit,
	type PageId,
	type PageInfo,
	parseCommitResult,
	parsePageInfo,
	parseSnapshot,
} from "@amime/sync";
import { PageApiError } from "./page-api-error.ts";
import { connectPageSocket } from "./page-socket.ts";
import type { PageApi } from "./page-sync.ts";

const STATUS_FORBIDDEN = 403;
/** 送った内容に問題があるときの応答(形が正しくない、大きすぎる)。 */
const STATUS_REJECTED: ReadonlySet<number | undefined> = new Set([400, 413]);

/** APIを呼び、応答の本文を検査して返す。失敗はすべて PageApiError にする。 */
async function request<T>(
	url: string,
	init: RequestInit | undefined,
	parse: (body: unknown) => Result<T, "invalid">,
): Promise<T> {
	const response = await fetch(url, init).catch(() => null);
	if (response?.status === STATUS_FORBIDDEN) throw new PageApiError("disabled");
	if (STATUS_REJECTED.has(response?.status)) throw new PageApiError("rejected");
	if (!response?.ok) throw new PageApiError("failed");

	const parsed = parse(await response.json().catch(() => null));
	if (!parsed.ok) throw new PageApiError("failed");
	return parsed.value;
}

const pagePath = (id: PageId): string => `/api/pages/${id}`;

/**
 * 名前(URLの中の名前)から、ページを引く(ADR-0024)。
 * まだないページには、サーバーがIDを決める。ページの本文は、書き込むまで作られない。
 */
export function openPage(name: string): Promise<PageInfo> {
	return request(`/api/pages/by-title/${encodeURIComponent(name)}`, undefined, parsePageInfo);
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
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...commit, client }),
				},
				parseCommitResult,
			),
	};
}
