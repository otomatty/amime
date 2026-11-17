import { describe, expect, it } from "vitest";
import {
	buildProjectFile,
	firstLineHolder,
	importLineIds,
	PROJECT_FILE_FORMAT,
	PROJECT_FILE_VERSION,
	type ProjectFilePage,
	parseProjectFile,
	planPageImport,
} from "./project-file.ts";
import { MAX_CHANGES, MAX_COMMIT_TEXT_LENGTH, MAX_LINE_LENGTH } from "./schema.ts";
import type { LineId } from "./types.ts";

const page = (title: string, ...rest: string[]) => ({
	title,
	lines: [title, ...rest],
	pinned: false,
	created: 1000,
	updated: 2000,
});

describe("buildProjectFile(プロジェクトの書き出し。ADR-0043)", () => {
	it("形式の名前と版、プロジェクトの名前、書き出した時刻と、ページを持つ", () => {
		const file = buildProjectFile(
			"notes",
			[page("買い物", "牛乳")],
			Date.UTC(2026, 10, 17, 1, 2, 3),
		);

		expect(file).toEqual({
			format: PROJECT_FILE_FORMAT,
			version: PROJECT_FILE_VERSION,
			project: "notes",
			exportedAt: "2026-11-17T01:02:03.000Z",
			pages: [page("買い物", "牛乳")],
		});
	});

	it("ページは、作った順(同じなら名前の順)に並べる。読み込み直すと、同じ順に作る", () => {
		const late = { ...page("後"), created: 3000 };
		const early = { ...page("先"), created: 1000 };
		const same = { ...page("あ"), created: 1000 };

		expect(buildProjectFile("notes", [late, early, same], 0).pages.map((p) => p.title)).toEqual([
			"あ",
			"先",
			"後",
		]);
	});
});

describe("parseProjectFile(書き出したファイルを読む)", () => {
	const valid = () => buildProjectFile("notes", [page("買い物", "牛乳", " 卵"), page("予定")], 0);

	it("書き出したファイルを、そのまま読める", () => {
		expect(parseProjectFile(JSON.stringify(valid()))).toEqual({ ok: true, value: valid() });
	});

	it("JSON でなければ、invalid-json", () => {
		expect(parseProjectFile("{")).toEqual({ ok: false, error: "invalid-json" });
	});

	it("このアプリの形式でなければ、not-project-file", () => {
		expect(parseProjectFile(JSON.stringify({ pages: [] }))).toEqual({
			ok: false,
			error: "not-project-file",
		});
		expect(parseProjectFile("[]")).toEqual({ ok: false, error: "not-project-file" });
		expect(parseProjectFile("null")).toEqual({ ok: false, error: "not-project-file" });
		expect(parseProjectFile(JSON.stringify({ format: "other-app", version: 1 }))).toEqual({
			ok: false,
			error: "not-project-file",
		});
	});

	it("新しい版の形式は、unsupported-version(読めないことを知らせる)", () => {
		const newer = { ...valid(), version: PROJECT_FILE_VERSION + 1 };

		expect(parseProjectFile(JSON.stringify(newer))).toEqual({
			ok: false,
			error: "unsupported-version",
		});
	});

	it("名前と1行目は、違ってよい(1行目が空、長すぎる、ほかのページと同じ名前のときは、名前が残る)", () => {
		const file = { ...valid(), pages: [{ ...page("買い物"), lines: ["", "牛乳"] }] };

		expect(parseProjectFile(JSON.stringify(file))).toEqual({ ok: true, value: file });
	});

	it.each([
		["行がない", { ...page("買い物"), lines: [] }],
		["行の中に改行がある", page("買い物", "1行目\n2行目")],
		["行が長すぎる", page("買い物", "あ".repeat(MAX_LINE_LENGTH + 1))],
		["名前が空", page("")],
		["固定しているかが、真偽値でない", { ...page("買い物"), pinned: "yes" }],
	])("ページの形が違えば(%s)、invalid", (_name, broken) => {
		const file = { ...valid(), pages: [page("ほか"), broken] };

		expect(parseProjectFile(JSON.stringify(file))).toEqual({ ok: false, error: "invalid" });
	});
});

describe("firstLineHolder(1行目の名前を持つ、ファイルの中のページ)", () => {
	const memo = { ...page("メモ"), lines: ["予定", "本文"] };
	const plan = { ...page("予定"), lines: ["", "本文"] };
	const file = buildProjectFile(
		"notes",
		[memo, plan, page("買い物"), { ...page("無題"), lines: ["どこにもない"] }],
		0,
	);
	const of = (title: string) => file.pages.find((p) => p.title === title) as ProjectFilePage;

	it("名前と1行目が違うページの1行目が、ファイルの中のページの名前なら、そのページ", () => {
		expect(firstLineHolder(file, of("メモ"))).toBe(of("予定"));
	});

	it("1行目が名前のページ、1行目がファイルの中のどのページの名前でもないページは、null", () => {
		expect(firstLineHolder(file, of("買い物"))).toBeNull();
		expect(firstLineHolder(file, of("無題"))).toBeNull();
		expect(firstLineHolder(file, of("予定"))).toBeNull();
	});

	it("名前の大文字と小文字、前後の空白の違いは、同じ名前として扱う", () => {
		const todo = page("Todo");
		const note = { ...page("ノート"), lines: [" todo ", "本文"] };
		const mixed = buildProjectFile("notes", [todo, note], 0);

		expect(firstLineHolder(mixed, note)).toEqual(todo);
	});
});

describe("importLineIds(読み込むページの行ID)", () => {
	const file = buildProjectFile("notes", [page("買い物", "牛乳", "卵"), page("予定")], 0);
	const byTitle = (title: string) => file.pages.find((p) => p.title === title) as ProjectFilePage;
	const shop = byTitle("買い物");
	const plan = byTitle("予定");

	it("同じファイルの同じページなら、いつも同じ行IDになる(やり直しと、同時の読み込みで、行が重ならない)", () => {
		expect(importLineIds(file, shop)).toEqual(importLineIds(file, shop));
		expect(importLineIds(file, shop)).toHaveLength(3);
		expect(new Set(importLineIds(file, shop)).size).toBe(3);
	});

	it("ページかファイルが違えば、違う行IDになる。どれも、行IDに使える形", () => {
		const other = { ...file, exportedAt: "2027-01-01T00:00:00.000Z" };
		const all = [
			...importLineIds(file, shop),
			...importLineIds(file, plan),
			...importLineIds(other, shop),
		];

		expect(new Set(all).size).toBe(all.length);
		for (const id of all) expect(id).toMatch(/^[\w-]{1,64}$/);
	});
});

describe("planPageImport(1つのページを、どう読み込むか)", () => {
	const ids = ["i1", "i2", "i3"] as LineId[];
	const shop = { ...page("買い物", "牛乳", "卵"), pinned: true };
	const empty = { version: 0, lines: [], pinned: false };
	const texts = (plan: ReturnType<typeof planPageImport>) =>
		plan?.commits.map((changes) =>
			changes.map((change) => (change.type === "insert" ? change.line.text : change.type)),
		);

	it("まだないページには、すべての行を上から順に、前の行の後ろへ足す。固定していたなら、固定する", () => {
		expect(planPageImport(shop, ids, empty)).toEqual({
			commits: [
				[
					{ type: "insert", line: { id: "i1", text: "買い物" }, after: null, before: null },
					{ type: "insert", line: { id: "i2", text: "牛乳" }, after: "i1", before: null },
					{ type: "insert", line: { id: "i3", text: "卵" }, after: "i2", before: null },
				],
			],
			pin: true,
			firstLine: null,
		});
	});

	it("名前と1行目が違うページは、まず1行目を名前にして作り、あとで1行目を元に戻す", () => {
		// 先に、すべてのページが自分の名前を持つ。1行目を戻したとき、1行目がほかのページの名前なら、
		// 台帳は名前を変えない(元のプロジェクトと同じ)。1行目から作ると、ほかのページの名前を取ってしまう。
		const memo = { ...page("メモ"), lines: ["予定", "本文"] };

		const plan = planPageImport(memo, ["i1", "i2"] as LineId[], empty);

		expect(texts(plan)).toEqual([["メモ", "本文"]]);
		expect(plan?.firstLine).toEqual({ type: "update", id: "i1", text: "予定", base: "メモ" });
	});

	it("1回のコミットに収まらない行は、変更の数と本文の長さの上限ごとに分ける", () => {
		const many = { ...page("多い"), lines: Array.from({ length: MAX_CHANGES + 1 }, () => "a") };
		const long = {
			...page("長い"),
			lines: Array.from({ length: 20 }, () => "あ".repeat(MAX_LINE_LENGTH)),
		};
		const idsOf = (p: ProjectFilePage) => p.lines.map((_, i) => `l${i}` as LineId);

		const manyPlan = planPageImport(many, idsOf(many), empty);
		const longPlan = planPageImport(long, idsOf(long), empty);

		expect(manyPlan?.commits.map((c) => c.length)).toEqual([MAX_CHANGES, 1]);
		expect(manyPlan?.commits[1]?.[0]).toMatchObject({ after: `l${MAX_CHANGES - 1}` });
		for (const commit of longPlan?.commits ?? []) {
			const length = commit.reduce(
				(sum, c) => sum + (c.type === "insert" ? c.line.text.length : 0),
				0,
			);
			expect(length).toBeLessThanOrEqual(MAX_COMMIT_TEXT_LENGTH);
		}
		expect(longPlan?.commits.flat()).toHaveLength(20);
	});

	/** 2回のコミットになるページ(2,000行と2行)。 */
	const long = {
		...page("長い"),
		lines: Array.from({ length: MAX_CHANGES + 2 }, (_, i) => `行${i}`),
	};
	const longIds = long.lines.map((_, i) => `l${i}` as LineId);
	const firstCommit = (version: number) => ({
		version,
		lines: long.lines
			.slice(0, MAX_CHANGES)
			.map((text, i) => ({ id: longIds[i] as LineId, text: i === 0 ? "長い" : text })),
		pinned: false,
	});

	it("前の読み込みが途中で止まったページ(送ったコミットの数と版が合う)には、続きの行だけを足す", () => {
		const plan = planPageImport(long, longIds, firstCommit(1));

		expect(texts(plan)).toEqual([[`行${MAX_CHANGES}`, `行${MAX_CHANGES + 1}`]]);
		expect(plan?.commits[0]?.[0]).toMatchObject({ after: `l${MAX_CHANGES - 1}` });
	});

	it("読み込み終えたあとで編集されたページは、行が途中までと同じでも、書き換えない(版が合わない)", () => {
		// 読み込み終えたあと(版は2)、末尾の2行を消した(版は3)。消した行を、足し直さない。
		expect(planPageImport(long, longIds, firstCommit(3))).toBeNull();
		// コミットの区切りでないところまでの行。
		const cut = { ...firstCommit(1), lines: firstCommit(1).lines.slice(0, 10) };
		expect(planPageImport(long, longIds, cut)).toBeNull();
	});

	it("行はすべて読み込んであるが、固定できていなかったページは、固定だけする", () => {
		const done = {
			version: 1,
			lines: shop.lines.map((text, i) => ({ id: ids[i] as LineId, text })),
			pinned: false,
		};

		expect(planPageImport(shop, ids, done)).toEqual({ commits: [], pin: true, firstLine: null });
		expect(planPageImport(shop, ids, { ...done, pinned: true })).toBeNull();
	});

	it("1行目を戻す前に止まったページは、1行目だけを戻す。戻してあれば、何もしない", () => {
		const memo = { ...page("メモ"), lines: ["", "本文"] };
		const memoIds = ["i1", "i2"] as LineId[];
		const created = {
			version: 1,
			lines: [
				{ id: "i1" as LineId, text: "メモ" },
				{ id: "i2" as LineId, text: "本文" },
			],
			pinned: false,
		};
		const restored = {
			...created,
			version: 2,
			lines: [{ ...created.lines[0], text: "" }, created.lines[1]],
		};

		expect(planPageImport(memo, memoIds, created)).toEqual({
			commits: [],
			pin: false,
			firstLine: { type: "update", id: "i1", text: "", base: "メモ" },
		});
		expect(planPageImport(memo, memoIds, restored as typeof created)).toBeNull();
	});

	it("同じ名前の、ほかのページ(行IDか本文が違う、行が多い、中身を消した)は、書き換えない", () => {
		const other = { version: 3, lines: [{ id: "x" as LineId, text: "買い物" }], pinned: false };
		const edited = {
			version: 2,
			lines: [{ id: "i1" as LineId, text: "買い物(直した)" }],
			pinned: false,
		};
		const longer = {
			version: 2,
			lines: [...shop.lines, "足した"].map((text, i) => ({ id: `i${i + 1}` as LineId, text })),
			pinned: true,
		};
		const cleared = { version: 5, lines: [], pinned: false };
		// 行の数と版は、読み込み終えたページと同じだが、行IDか本文が違う。
		const sameShape = {
			version: 1,
			lines: shop.lines.map((text, i) => ({ id: `x${i}` as LineId, text })),
			pinned: false,
		};
		const changedText = {
			version: 1,
			lines: shop.lines.map((text, i) => ({
				id: ids[i] as LineId,
				text: i === 2 ? "卵 2個" : text,
			})),
			pinned: false,
		};

		for (const existing of [other, edited, longer, cleared, sameShape, changedText]) {
			expect(planPageImport(shop, ids, existing)).toBeNull();
		}
	});
});
