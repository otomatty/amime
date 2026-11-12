import type { Result } from "@amime/shared";
import { type Change, parseCommitResult, parseSnapshot } from "@amime/sync";
import { PageApiError } from "./page-api-error.ts";
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
