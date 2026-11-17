import {
	buildProjectFile,
	firstLineHolder,
	importLineIds,
	type PageCard,
	type PageId,
	type ProjectFile,
	type ProjectFilePage,
	planPageImport,
} from "@tsuzuri/sync";
import { createPageApi, isPageSaved, listPages, openPage, pinPage } from "../page/api.ts";
import { createClientId } from "../page/client-id.ts";
import { createCommitId } from "../page/commit-id.ts";
import { PageApiError } from "../page/page-api-error.ts";

/**
 * プロジェクトの書き出しと読み込み(ADR-0043、US-14)。
 * どちらも、画面から、いつものAPI(一覧、ページを読む、書き込む、固定する)を使う。
 * ログインの状態とプロジェクトの権限は、それぞれのAPIが確かめる。
 */

/** 進み具合(済んだページの数、全体の数)。 */
type Progress = (done: number, total: number) => void;

/** 同時に読み書きするページの数。多すぎると、サーバーとブラウザの両方に負担がかかる。 */
const CONCURRENCY = 4;

/**
 * items を、同時に CONCURRENCY 個までの task で処理する。結果は items と同じ順。1つでも失敗したら、失敗する。
 * 失敗したあとは、新しい task を始めず、動いている task が終わっても onDone を呼ばない
 * (失敗を知らせたあとで、進み具合が届かないようにする)。
 */
async function inParallel<T, R>(
	items: readonly T[],
	task: (item: T) => Promise<R>,
	onDone: () => void,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		while (!failed && next < items.length) {
			const index = next;
			next += 1;
			try {
				// biome-ignore lint/style/noNonNullAssertion: index は items の範囲の中
				results[index] = await task(items[index]!);
			} catch (error) {
				failed = true;
				throw error;
			}
			if (!failed) onDone();
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return results;
}

/** 一覧を、最初から最後まで1回たどる(作った順)。 */
async function listOnce(): Promise<PageCard[]> {
	const cards: PageCard[] = [];
	for (;;) {
		const { pages, total } = await listPages({ sort: "created", offset: cards.length });
		cards.push(...pages);
		// 取り出しているあいだにページが消えると、total に届かないことがある。空の応答で止める。
		if (pages.length === 0 || cards.length >= total) return cards;
	}
}

/** 一覧をたどり直す回数の上限。 */
const MAX_PASSES = 3;

/**
 * 保存されているページを、一覧から取り出す(並びは、書き出しファイルを作るときに決める)。
 * 一覧は、何件目からを指して取り出す。取り出しているあいだに、取り出し終えた範囲のページが消されると、
 * 後ろのページが前にずれて、取りこぼす。新しいページが見つからなくなるまで、たどり直す。
 */
async function allPages(): Promise<PageCard[]> {
	const found = new Map<string, PageCard>();
	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		const before = found.size;
		for (const card of await listOnce()) if (!found.has(card.id)) found.set(card.id, card);
		if (pass > 0 && found.size === before) break;
	}
	return [...found.values()];
}

type ExportOptions = {
	readonly onProgress?: Progress;
	readonly now?: () => number;
};

/**
 * プロジェクトのすべてのページを読んで、書き出しファイルにする。
 * 読めないページが1つでもあれば、途中までのファイルにせず、失敗する(足りないバックアップを作らない)。
 */
export async function exportProject(
	project: string,
	{ onProgress, now = Date.now }: ExportOptions = {},
): Promise<ProjectFile> {
	const cards = await allPages();
	const client = createClientId();
	let done = 0;
	const pages = await inParallel(
		cards,
		async (card): Promise<ProjectFilePage | null> => {
			const loaded = await createPageApi(card.id, client)
				.load()
				.catch((error: unknown) => {
					// 一覧に出たあとで消されたページ(410、404)は、書き出さない。それ以外の失敗は、書き出しの失敗。
					if (
						error instanceof PageApiError &&
						(error.kind === "gone" || error.kind === "missing")
					) {
						return null;
					}
					throw error;
				});
			if (loaded === null) return null;
			// 保存されているが行のないページ(2人が別々の行を消した、など)もある。名前と固定を失わないように、
			// 空の1行のページとして書き出す(ファイルのページには、1行以上が要る)。
			const texts = loaded.lines.map((line) => line.text);
			// 名前は、台帳の名前にする。1行目が空、長すぎる、ほかのページと同じ名前のときは、
			// 名前は1行目と違う(ADR-0024)。1行目を名前にすると、そのページを読み込めなくなる。
			return {
				title: card.title,
				lines: texts.length === 0 ? [""] : texts,
				pinned: card.pinned,
				created: card.created,
				updated: card.updated,
			};
		},
		() => {
			done += 1;
			onProgress?.(done, cards.length);
		},
	);
	return buildProjectFile(
		project,
		pages.filter((page) => page !== null),
		now(),
	);
}

/** 読み込んだ結果(ページの名前)。 */
export type ImportResult = {
	/** 作ったページ。 */
	readonly created: readonly string[];
	/** 同じ名前のページがもうあったので、書き換えずに飛ばしたページ。 */
	readonly skipped: readonly string[];
	/** 送れなかったページ。 */
	readonly failed: readonly string[];
};

type PageOutcome = "created" | "skipped" | "failed";

/** 1つのページの、1回目の読み込みの結果。finish は、すべてのページのあとで、1行目を戻す処理。 */
type Staged =
	| { readonly outcome: "failed" }
	| { readonly outcome: "skipped"; readonly id: PageId }
	| {
			readonly outcome: "created";
			readonly id: PageId;
			readonly finish: (() => Promise<unknown>) | null;
	  };

/**
 * 1つのページを作る(行を足し、固定する。1行目は、いったん名前にしておく。planPageImport)。
 * 同じ名前の、ほかのページがもうあれば、書き換えない。
 * 前の読み込みが途中で止まったページは、続きを送る。
 */
async function stagePage(
	file: ProjectFile,
	page: ProjectFilePage,
	client: ReturnType<typeof createClientId>,
): Promise<Staged> {
	try {
		const info = await openPage(page.title);
		const api = createPageApi(info.id, client);
		const snapshot = await api.load();
		const plan = planPageImport(page, importLineIds(file, page), {
			version: snapshot.version,
			lines: snapshot.lines,
			pinned: info.pinned,
		});
		if (plan === null) return { outcome: "skipped", id: info.id };
		for (const changes of plan.commits) {
			await api.commit({ id: createCommitId(), changes });
		}
		if (plan.pin) await pinPage(info.id, true);
		const { firstLine } = plan;
		const finish =
			firstLine === null ? null : () => api.commit({ id: createCommitId(), changes: [firstLine] });
		return { outcome: "created", id: info.id, finish };
	} catch {
		return { outcome: "failed" };
	}
}

/** 台帳に載るのを待つ回数と間隔(最大で20秒)。ページは、保存の数秒後(最大で10秒ほど)に台帳に載る。 */
const LISTED_TRIES = 40;
const LISTED_INTERVAL_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * そのページが、台帳に、保存されたページとして載るまで待つ。載らなければ false。
 * 名前で探す(searchTitles)と、名前の似たページが多いプロジェクトでは、候補に入らないことがある。IDで確かめる。
 */
async function waitSaved(id: PageId, wait: (ms: number) => Promise<void>): Promise<boolean> {
	for (let attempt = 0; attempt < LISTED_TRIES; attempt += 1) {
		if (await isPageSaved(id)) return true;
		await wait(LISTED_INTERVAL_MS);
	}
	return false;
}

type ImportOptions = {
	readonly onProgress?: Progress;
	/** 待つ(テストで差し替える)。 */
	readonly wait?: (ms: number) => Promise<void>;
};

/**
 * 名前と1行目が違うページの1行目を戻す。1行目の名前を持つページ(firstLineHolder)が台帳に載ってから戻す。
 * そのページを作れなかったか、台帳に載らなければ、戻さない(戻すと、このページが名前を取ってしまう)。
 * どちらも、やり直したときに仕上げる。
 */
async function finishPage(
	file: ProjectFile,
	page: ProjectFilePage,
	finish: () => Promise<unknown>,
	staged: ReadonlyMap<ProjectFilePage, PageId>,
	wait: (ms: number) => Promise<void>,
): Promise<PageOutcome> {
	try {
		const holder = firstLineHolder(file, page);
		const holderId = holder === null ? undefined : staged.get(holder);
		if (holder !== null && (holderId === undefined || !(await waitSaved(holderId, wait)))) {
			return "failed";
		}
		await finish();
		return "created";
	} catch {
		return "failed";
	}
}

/**
 * 書き出しファイルのページを、いま開いているプロジェクトに作る。
 * 同じ名前のページがもうあれば、書き換えずに飛ばす(読み込みで、いまのページを失わない)。
 * 送れなかったページがあっても、ほかのページは続ける。結果に、それぞれの名前を返す。
 * 同じファイルを読み込み直すと、途中で止まったページの続きと、まだないページだけを作る。
 */
export async function importProject(
	file: ProjectFile,
	{ onProgress, wait = sleep }: ImportOptions = {},
): Promise<ImportResult> {
	const client = createClientId();
	const outcomes = new Map<ProjectFilePage, PageOutcome>();
	const finishing: [ProjectFilePage, () => Promise<unknown>][] = [];
	// 1回目で、作ったか、もうあったページと、そのID。
	const staged = new Map<ProjectFilePage, PageId>();
	let done = 0;
	const settle = (page: ProjectFilePage, outcome: PageOutcome) => {
		outcomes.set(page, outcome);
		done += 1;
		onProgress?.(done, file.pages.length);
	};
	// 名前は、行を足したときに台帳が決め、ほかのページの名前に影響する。1つずつ行う。
	// まず、すべてのページを、それぞれの名前で作る。そのあとで、名前と1行目が違うページの1行目を戻す。
	for (const page of file.pages) {
		const result = await stagePage(file, page, client);
		if (result.outcome !== "failed") staged.set(page, result.id);
		if (result.outcome === "created" && result.finish !== null)
			finishing.push([page, result.finish]);
		else settle(page, result.outcome);
	}
	for (const [page, finish] of finishing) {
		settle(page, await finishPage(file, page, finish, staged, wait));
	}
	const titles = (outcome: PageOutcome) =>
		file.pages.filter((page) => outcomes.get(page) === outcome).map((page) => page.title);
	return { created: titles("created"), skipped: titles("skipped"), failed: titles("failed") };
}
