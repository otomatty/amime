import { describe, expect, it } from "vitest";
import {
	buildProjectFile,
	insertionCommits,
	PROJECT_FILE_FORMAT,
	PROJECT_FILE_VERSION,
	parseProjectFile,
} from "./project-file.ts";
import { MAX_LINE_LENGTH } from "./schema.ts";
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

	it.each([
		["1行目と名前が違う", { ...page("買い物"), lines: ["別の名前"] }],
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

describe("insertionCommits(ページの行を、空のページに足すコミット)", () => {
	const ids = () => {
		let next = 0;
		return () => {
			next += 1;
			return `l${next}` as LineId;
		};
	};

	it("行を、上から順に、前の行の後ろへ足す", () => {
		expect(insertionCommits(["題", "本文"], ids())).toEqual([
			[
				{ type: "insert", line: { id: "l1", text: "題" }, after: null, before: null },
				{ type: "insert", line: { id: "l2", text: "本文" }, after: "l1", before: null },
			],
		]);
	});

	it("1回のコミットの変更の数に上限があるので、上限ごとに分ける。続きは、前のコミットの最後の行の後ろへ足す", () => {
		const commits = insertionCommits(["a", "b", "c", "d", "e"], ids(), 2);

		expect(commits.map((changes) => changes.length)).toEqual([2, 2, 1]);
		expect(commits[1]?.[0]).toMatchObject({ line: { text: "c" }, after: "l2" });
		expect(commits[2]?.[0]).toMatchObject({ line: { text: "e" }, after: "l4" });
	});

	it("行がなければ、コミットもない", () => {
		expect(insertionCommits([], ids())).toEqual([]);
	});
});
