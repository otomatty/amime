import type { Result } from "@amime/shared";
import { type Change, parseCommitResult, parseSnapshot } from "@amime/sync";
import type { PageApi } from "./page-sync.ts";

/**
 * ページのAPIの失敗。
 * - disabled: この環境ではページのAPIが無効(認証が入るまでの公開環境)
 * - failed: 通信やサーバーの失敗、想定と違う応答
 */
export class PageApiError extends Error {
	override readonly name = "PageApiError";
	readonly kind: "disabled" | "failed";

	constructor(kind: "disabled" | "failed") {
		super(`page api ${kind}`);
		this.kind = kind;
	}
}

const STATUS_FORBIDDEN = 403;

/** APIを呼び、応答の本文を検査して返す。失敗はすべて PageApiError にする。 */
async function request<T>(
	url: string,
	init: RequestInit | undefined,
	parse: (body: unknown) => Result<T, "invalid">,
): Promise<T> {
	const response = await fetch(url, init).catch(() => null);
	if (response?.status === STATUS_FORBIDDEN) throw new PageApiError("disabled");
	if (!response?.ok) throw new PageApiError("failed");

	const parsed = parse(await response.json().catch(() => null));
	if (!parsed.ok) throw new PageApiError("failed");
	return parsed.value;
}

/** 指定したページを読み書きするAPI。 */
export function createPageApi(name: string): PageApi {
	const url = `/api/pages/${encodeURIComponent(name)}`;
	return {
		load: () => request(url, undefined, parseSnapshot),
		commit: (changes: readonly Change[]) =>
			request(
				`${url}/commits`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ changes }),
				},
				parseCommitResult,
			),
	};
}
