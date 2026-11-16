import { describe, expect, it } from "vitest";
import { pendingPages, strayPages } from "./pending-pages.ts";
import type { PageId } from "./types.ts";

const id = (value: string) => value as PageId;
const record = (page: string, title: string, savedAt: number, project = "notes") => ({
	project,
	id: id(page),
	title,
	savedAt,
});

describe("pendingPages(この端末に、送れていない変更が残っているページ)", () => {
	it("プロジェクトのページを、新しく残した順に並べる", () => {
		expect(
			pendingPages(
				[
					record("a1", "古い", 100),
					record("b2", "新しい", 300),
					record("c3", "別のプロジェクト", 500, "other"),
				],
				"notes",
			),
		).toEqual([
			{ id: id("b2"), title: "新しい", savedAt: 300 },
			{ id: id("a1"), title: "古い", savedAt: 100 },
		]);
	});

	it("同じページの記録が複数(タブごと)あれば、1つにまとめる。名前と時刻は、いちばん新しい記録のもの", () => {
		expect(
			pendingPages([record("a1", "前の名前", 100), record("a1", "いまの名前", 200)], "notes"),
		).toEqual([{ id: id("a1"), title: "いまの名前", savedAt: 200 }]);
		expect(
			pendingPages([record("a1", "いまの名前", 200), record("a1", "前の名前", 100)], "notes"),
		).toEqual([{ id: id("a1"), title: "いまの名前", savedAt: 200 }]);
	});

	it("記録がなければ、空", () => {
		expect(pendingPages([], "notes")).toEqual([]);
	});
});

describe("strayPages(開いたページと同じ名前で残っている、別のページの変更)", () => {
	const opened = { project: "notes", id: id("now1"), title: "出張メモ" };

	it("同じ名前で、IDが違う記録を返す", () => {
		expect(strayPages([record("old1", "出張メモ", 100)], opened)).toEqual([
			{ id: id("old1"), title: "出張メモ", savedAt: 100 },
		]);
	});

	it("名前は、大文字と小文字、空白とアンダースコアの違いを区別しない(ページの名前と同じ規則)", () => {
		const page = { project: "notes", id: id("now1"), title: "Trip memo" };

		expect(strayPages([record("old1", "trip_memo", 100)], page)).toHaveLength(1);
	});

	it("開いたページそのものの記録は、返さない(そのまま復元する)", () => {
		expect(strayPages([record("now1", "出張メモ", 100)], opened)).toEqual([]);
	});

	it("名前が違う記録と、別のプロジェクトの記録は、返さない", () => {
		expect(
			strayPages(
				[record("old1", "別のメモ", 100), record("old2", "出張メモ", 100, "other")],
				opened,
			),
		).toEqual([]);
	});

	it("同じページの記録が複数あれば、1つにまとめる。いちばん新しい記録の名前で比べる", () => {
		expect(
			strayPages([record("old1", "出張メモ", 100), record("old1", "出張メモ", 300)], opened),
		).toEqual([{ id: id("old1"), title: "出張メモ", savedAt: 300 }]);
		// 名前を変えて書き続けたページは、前の名前では案内しない。
		expect(
			strayPages([record("old1", "出張メモ", 100), record("old1", "旅のメモ", 300)], opened),
		).toEqual([]);
	});
});
