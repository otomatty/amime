import {
	buildProjectFile,
	insertionCommits,
	type LineId,
	type PageCard,
	type ProjectFile,
	type ProjectFilePage,
} from "@tsuzuri/sync";
import { createIdPrefix } from "../editor/editor-model.ts";
import { createPageApi, listPages, openPage, pinPage } from "../page/api.ts";
import { createClientId } from "../page/client-id.ts";
import { createCommitId } from "../page/commit-id.ts";

/**
 * プロジェクトの書き出しと読み込み(ADR-0043、US-14)。
 * どちらも、画面から、いつものAPI(一覧、ページを読む、書き込む、固定する)を使う。
 * ログインの状態とプロジェクトの権限は、それぞれのAPIが確かめる。
 */

/** 進み具合(済んだページの数、全体の数)。 */
type Progress = (done: number, total: number) => void;

/** 同時に読み書きするページの数。多すぎると、サーバーとブラウザの両方に負担がかかる。 */
const CONCURRENCY = 4;

/** items を、同時に concurrency 個までの task で処理する。結果は items と同じ順。1つでも失敗したら、失敗する。 */
async function inParallel<T, R>(
	items: readonly T[],
	task: (item: T) => Promise<R>,
	onDone: () => void,
	concurrency = CONCURRENCY,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			// biome-ignore lint/style/noNonNullAssertion: index は items の範囲の中
			results[index] = await task(items[index]!);
			onDone();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

/** 保存されているページを、一覧から最後まで取り出す(作った順)。 */
async function allPages(): Promise<PageCard[]> {
	const cards: PageCard[] = [];
	for (;;) {
		const { pages, total } = await listPages({ sort: "created", offset: cards.length });
		cards.push(...pages);
		// 取り出しているあいだにページが消えると、total に届かないことがある。空の応答で止める。
		if (pages.length === 0 || cards.length >= total) return cards;
	}
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
			const { lines } = await createPageApi(card.id, client).load();
			// 一覧に出たあとで消されたページは、本文が空になる。書き出さない。
			if (lines.length === 0) return null;
			const texts = lines.map((line) => line.text);
			// 名前は、1行目から決まる(一覧の名前が、まだ追いついていないこともある)。
			return {
				title: texts[0] ?? card.title,
				lines: texts,
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

/** 1つのページを読み込む。同じ名前のページがもうあれば、書き換えない。 */
async function importPage(
	page: ProjectFilePage,
	client: ReturnType<typeof createClientId>,
): Promise<PageOutcome> {
	try {
		const info = await openPage(page.title);
		const api = createPageApi(info.id, client);
		const snapshot = await api.load();
		if (snapshot.version > 0 || snapshot.lines.length > 0) return "skipped";
		const prefix = createIdPrefix();
		let serial = 0;
		const createId = () => {
			serial += 1;
			return `${prefix}-${serial.toString(36)}` as LineId;
		};
		for (const changes of insertionCommits(page.lines, createId)) {
			await api.commit({ id: createCommitId(), changes });
		}
		if (page.pinned) await pinPage(info.id, true);
		return "created";
	} catch {
		return "failed";
	}
}

type ImportOptions = {
	readonly onProgress?: Progress;
};

/**
 * 書き出しファイルのページを、いま開いているプロジェクトに作る。
 * 同じ名前のページがもうあれば、書き換えずに飛ばす(読み込みで、いまのページを失わない)。
 * 送れなかったページがあっても、ほかのページは続ける。結果に、それぞれの名前を返す。
 */
export async function importProject(
	file: ProjectFile,
	{ onProgress }: ImportOptions = {},
): Promise<ImportResult> {
	const client = createClientId();
	let done = 0;
	// 名前が同じページを同時に開くと、同じページに2回書き込むことがある。読み込みは1つずつ行う。
	const outcomes = await inParallel(
		file.pages,
		(page) => importPage(page, client),
		() => {
			done += 1;
			onProgress?.(done, file.pages.length);
		},
		1,
	);
	const titles = (outcome: PageOutcome) =>
		file.pages.filter((_, index) => outcomes[index] === outcome).map((page) => page.title);
	return { created: titles("created"), skipped: titles("skipped"), failed: titles("failed") };
}
