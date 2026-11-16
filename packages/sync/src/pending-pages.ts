import { toTitleLc } from "@tsuzuri/shared";
import type { PageId, PendingPage } from "./types.ts";

/** 端末内に残っている記録1つ(どのページのものかと、残した時刻)。同じページに、タブごとの記録が複数あることもある。 */
export type StoredPending = PendingPage & { readonly savedAt: number };

/** 送れていない変更が、この端末に残っているページ。 */
export type PendingPageSummary = {
	readonly id: PageId;
	/** いちばん新しく残した記録の、ページの名前。 */
	readonly title: string;
	/** いちばん新しく残した時刻(ミリ秒)。 */
	readonly savedAt: number;
};

/**
 * プロジェクトのページのうち、送れていない変更が、この端末に残っているもの(ADR-0042)。
 * ページごとに、いちばん新しい記録にまとめ、新しく残した順に並べる。
 */
export function pendingPages(
	records: readonly StoredPending[],
	project: string,
): PendingPageSummary[] {
	const latest = new Map<PageId, PendingPageSummary>();
	for (const { project: owner, id, title, savedAt } of records) {
		if (owner !== project) continue;
		const known = latest.get(id);
		if (known === undefined || known.savedAt < savedAt) latest.set(id, { id, title, savedAt });
	}
	return [...latest.values()].sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * 開いたページと同じ名前で残っている、別のページの変更(ADR-0042、Issue #18)。
 * 通信できないまま書いた新しいページの名前を、他のページが使った。または、閉じているあいだに、
 * 他の人がページの名前を変えた。どちらも、名前からは、変更を残したページを引けない。
 * 名前は、ページの名前と同じ規則で比べる(大文字と小文字、空白とアンダースコアの違いは区別しない)。
 */
export function strayPages(
	records: readonly StoredPending[],
	opened: PendingPage,
): PendingPageSummary[] {
	const name = toTitleLc(opened.title);
	return pendingPages(records, opened.project).filter(
		(page) => page.id !== opened.id && toTitleLc(page.title) === name,
	);
}
