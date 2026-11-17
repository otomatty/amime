import { buildProjectFile, type ProjectFilePage } from "@tsuzuri/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportProject, importProject } from "./backup.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

const card = (
	id: string,
	title: string,
	extra: Partial<{ pinned: boolean; created: number }> = {},
) => ({
	id,
	title,
	descriptions: [],
	image: null,
	updated: 2000,
	created: extra.created ?? 1000,
	linked: 0,
	pinned: extra.pinned ?? false,
});

/** URL ごとの応答を決めて、fetch を差し替える。呼ばれた URL と、送った本文を記録する。 */
function stubServer(route: (url: string, init?: RequestInit) => Response | undefined) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			});
			return route(url, init) ?? json({ error: "unexpected" }, 500);
		}),
	);
	return calls;
}

beforeEach(() => {
	window.history.replaceState(null, "", "/team/settings");
	window.history.replaceState(null, "", "/settings/team");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("exportProject(プロジェクトのすべてのページを、1つのファイルにする。ADR-0043)", () => {
	it("一覧を最後までたどり、それぞれのページの本文を読んで、ファイルにする", async () => {
		const first = Array.from({ length: 100 }, (_, i) => card(`p${i}`, `ページ${i}`));
		const calls = stubServer((url) => {
			if (url === "/api/projects/team/pages?sort=created&offset=0")
				return json({ pages: first, total: 101 });
			if (url === "/api/projects/team/pages?sort=created&offset=100") {
				return json({ pages: [card("last", "最後", { pinned: true, created: 5000 })], total: 101 });
			}
			const id = /\/pages\/([^/]+)$/.exec(url)?.[1];
			if (id === undefined) return undefined;
			const title = id === "last" ? "最後" : `ページ${id.slice(1)}`;
			return json({
				version: 3,
				lines: [
					{ id: "a", text: title },
					{ id: "b", text: `${id} の本文` },
				],
			});
		});
		const progress: [number, number][] = [];

		const file = await exportProject("team", {
			now: () => 0,
			onProgress: (done, total) => progress.push([done, total]),
		});

		expect(file.project).toBe("team");
		expect(file.pages).toHaveLength(101);
		expect(file.pages.at(-1)).toEqual({
			title: "最後",
			lines: ["最後", "last の本文"],
			pinned: true,
			created: 5000,
			updated: 2000,
		});
		// 2回たどって、取りこぼしがないことを確かめる。
		expect(calls.filter((call) => call.url.includes("?sort="))).toHaveLength(4);
		expect(progress.at(-1)).toEqual([101, 101]);
	});

	it("たどっているあいだに、取り出したページが消されて、一覧がずれても、ほかのページを取りこぼさない", async () => {
		const cards = Array.from({ length: 101 }, (_, i) => card(`p${i}`, `ページ${i}`));
		stubServer((url) => {
			const offset = /[?&]offset=(\d+)/.exec(url)?.[1];
			if (offset !== undefined) {
				const pages = cards.slice(Number(offset), Number(offset) + 100);
				// 先頭の100件を取り出したあとで、その中の1件が消される。残りの1件が、1つ前にずれる。
				if (offset === "0" && cards[5]?.id === "p5") cards.splice(5, 1);
				return json({ pages, total: cards.length });
			}
			const id = /\/pages\/([^/]+)$/.exec(url)?.[1];
			if (id === "p5") return json({ version: 3, lines: [] });
			return json({ version: 3, lines: [{ id: "a", text: `${id}` }] });
		});

		const file = await exportProject("team", { now: () => 0 });

		expect(file.pages.map((page) => page.title)).toContain("ページ100");
		expect(file.pages).toHaveLength(100);
	});

	it("一覧に出たあとで消されたページ(本文が空)は、書き出さない", async () => {
		stubServer((url) => {
			if (url.includes("?sort=")) return json({ pages: [card("gone", "消えた")], total: 1 });
			return json({ version: 0, lines: [] });
		});

		expect((await exportProject("team", { now: () => 0 })).pages).toEqual([]);
	});

	it("名前は、一覧(台帳)の名前にする。1行目が名前にできないページでも、名前を失わない", async () => {
		stubServer((url) => {
			if (url.includes("?sort=")) return json({ pages: [card("p1", "メモ")], total: 1 });
			return json({
				version: 2,
				lines: [
					{ id: "a", text: "" },
					{ id: "b", text: "本文" },
				],
			});
		});

		const file = await exportProject("team", { now: () => 0 });

		expect(file.pages.map((page) => [page.title, page.lines])).toEqual([["メモ", ["", "本文"]]]);
	});

	it("失敗したあとは、ほかのページを読み終えても、進み具合を知らせない(画面が、書き出し中に戻らない)", async () => {
		stubServer((url) => {
			if (url.includes("?sort=")) {
				return json({ pages: [card("bad", "一"), card("slow", "二"), card("c", "三")], total: 3 });
			}
			if (url.endsWith("/bad")) return json({ error: "unavailable" }, 503);
			return undefined;
		});
		const original = vi.mocked(fetch).getMockImplementation();
		vi.mocked(fetch).mockImplementation(async (url, init) => {
			if (String(url).endsWith("/slow") || String(url).endsWith("/c")) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return json({ version: 1, lines: [{ id: "a", text: "二" }] });
			}
			return original?.(url, init) ?? json({}, 500);
		});
		const progress: [number, number][] = [];

		await expect(
			exportProject("team", {
				now: () => 0,
				onProgress: (done, total) => progress.push([done, total]),
			}),
		).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(progress).toEqual([]);
	});

	it("読めないページがあれば、途中までのファイルにせず、失敗を知らせる", async () => {
		stubServer((url) => {
			if (url.includes("?sort=")) return json({ pages: [card("p1", "一")], total: 1 });
			return json({ error: "unavailable" }, 503);
		});

		await expect(exportProject("team", { now: () => 0 })).rejects.toThrow();
	});
});

describe("importProject(書き出したファイルを、プロジェクトに読み込む)", () => {
	const page = (title: string, ...rest: string[]): ProjectFilePage => ({
		title,
		lines: [title, ...rest],
		pinned: false,
		created: 1000,
		updated: 2000,
	});

	type StoredLine = { id: string; text: string };
	type Stored = { title: string; version: number; lines: StoredLine[]; pinned: boolean };

	/**
	 * 名前でページを開き、コミットと固定を受け付けるサーバー。状態を持つ。
	 * exists の名前のページは、もうある(ほかの人が作ったページ)。
	 * 同じ ID の行を足す変更は、本物と同じく何もしない。
	 */
	function server(exists: readonly string[] = [], { listedAfter = 0 } = {}) {
		const pages = new Map<string, Stored>();
		for (const title of exists) {
			pages.set(`id-${pages.size}`, {
				title,
				version: 4,
				lines: [{ id: "x", text: title }],
				pinned: false,
			});
		}
		const find = (title: string) => [...pages].find(([, page]) => page.title === title)?.[0];
		const openByTitle = (title: string) => {
			const id = find(title) ?? `id-${pages.size}`;
			if (!pages.has(id)) pages.set(id, { title, version: 0, lines: [], pinned: false });
			const page = pages.get(id) as Stored;
			return json({ id, title, problem: null, pinned: page.pinned });
		};
		/** 本物の台帳と同じく、名前を1行目に合わせる。空の1行目と、行のあるほかのページの名前には、合わせない。 */
		const retitle = (id: string, page: Stored) => {
			const wanted = page.lines[0]?.text ?? "";
			const holder = find(wanted);
			if (
				wanted === "" ||
				(holder !== undefined && holder !== id && pages.get(holder)?.version !== 0)
			)
				return;
			// 開いただけのページの名前は、空いているものとして扱い、そのページを台帳から消す。
			if (holder !== undefined && holder !== id) pages.delete(holder);
			page.title = wanted;
		};
		type Sent = {
			type: string;
			id?: string;
			text?: string;
			line?: StoredLine;
			after?: string | null;
		};
		const apply = (page: Stored, change: Sent) => {
			if (change.type === "update") {
				const line = page.lines.find((l) => l.id === change.id);
				if (line !== undefined) line.text = change.text ?? "";
				return;
			}
			const { line, after } = change as { line: StoredLine; after: string | null };
			if (page.lines.some((l) => l.id === line.id)) return;
			page.lines.splice(
				after === null ? 0 : page.lines.findIndex((l) => l.id === after) + 1,
				0,
				line,
			);
		};
		const commit = (id: string, body: string) => {
			const page = pages.get(id) as Stored;
			const changes = JSON.parse(body).changes as Sent[];
			for (const change of changes) apply(page, change);
			page.version += 1;
			retitle(id, page);
			return json({ version: page.version, applied: changes });
		};
		const pin = (id: string) => {
			const page = pages.get(id) as Stored;
			page.pinned = true;
			return json({ id, title: page.title, problem: null, pinned: true });
		};
		const load = (id: string | undefined) => {
			const page = id === undefined ? undefined : pages.get(id);
			return page === undefined ? undefined : json({ version: page.version, lines: page.lines });
		};
		// 台帳に載るのは、保存の少しあと。保存されたかを listedAfter 回目まで問われるあいだは、まだ載っていない。
		let asked = 0;
		const saved = (id: string) => {
			asked += 1;
			return json({ id, saved: asked > listedAfter && (pages.get(id)?.version ?? 0) > 0 });
		};
		const calls = stubServer((url, init) => {
			const infoId = /\/pages\/([^/]+)\/info$/.exec(url)?.[1];
			if (infoId !== undefined) return saved(infoId);
			const byTitle = /\/pages\/by-title\/([^/?]+)$/.exec(url)?.[1];
			if (byTitle !== undefined)
				return openByTitle(decodeURIComponent(byTitle).replaceAll("_", " "));
			const commitId = /\/pages\/([^/]+)\/commits$/.exec(url)?.[1];
			if (commitId !== undefined && init?.method === "POST")
				return commit(commitId, String(init.body));
			const pinId = /\/pages\/([^/]+)\/pin$/.exec(url)?.[1];
			if (pinId !== undefined) return pin(pinId);
			return load(/\/pages\/([^/]+)$/.exec(url)?.[1]);
		});
		return { calls, pages: () => [...pages.values()] };
	}

	/** 条件に合う要求を、決めた回数だけ失敗させる。 */
	function failWhen(match: (url: string, body: string) => boolean, times = 1) {
		const original = vi.mocked(fetch).getMockImplementation();
		let left = times;
		vi.mocked(fetch).mockImplementation(async (url, init) => {
			if (left > 0 && match(String(url), String(init?.body))) {
				left -= 1;
				return json({ error: "unavailable" }, 503);
			}
			return original?.(url, init) ?? json({}, 500);
		});
	}

	it("まだない名前のページを作り、すべての行を送る。固定していたページは、固定する", async () => {
		const { calls } = server();
		const file = buildProjectFile(
			"old",
			[page("買い物", "牛乳", " 卵"), { ...page("予定"), pinned: true, created: 3000 }],
			0,
		);

		const result = await importProject(file);

		expect(result).toEqual({ created: ["買い物", "予定"], skipped: [], failed: [] });
		const commits = calls.filter((call) => call.url.endsWith("/commits"));
		expect(
			commits.map((call) =>
				(call.body as { changes: { line: { text: string } }[] }).changes.map((c) => c.line.text),
			),
		).toEqual([["買い物", "牛乳", " 卵"], ["予定"]]);
		expect(calls.filter((call) => call.url.endsWith("/pin")).map((call) => call.body)).toEqual([
			{ pinned: true },
		]);
	});

	it("同じ名前のページがもうあれば、書き換えずに飛ばす", async () => {
		const { calls, pages } = server(["買い物"]);

		const result = await importProject(
			buildProjectFile("old", [page("買い物", "牛乳"), page("予定")], 0),
		);

		expect(result).toEqual({ created: ["予定"], skipped: ["買い物"], failed: [] });
		expect(calls.filter((call) => call.url.endsWith("/commits"))).toHaveLength(1);
		expect(pages()[0]?.lines).toEqual([{ id: "x", text: "買い物" }]);
	});

	it("送れなかったページは、失敗として知らせ、ほかのページは続ける", async () => {
		server();
		failWhen((url, body) => url.includes("/commits") && body.includes("壊れる"));

		const result = await importProject(buildProjectFile("old", [page("壊れる"), page("予定")], 0));

		expect(result.created).toEqual(["予定"]);
		expect(result.failed).toEqual(["壊れる"]);
	});

	it("途中で止まったページは、やり直すと、続きの行だけを送って仕上げる", async () => {
		const { pages } = server();
		const lines = Array.from({ length: 2_000 }, (_, i) => `行${i}`);
		const file = buildProjectFile("old", [page("長い", ...lines)], 0);
		failWhen((url, body) => url.includes("/commits") && body.includes("行1999"));

		expect(await importProject(file)).toEqual({ created: [], skipped: [], failed: ["長い"] });
		expect(pages()[0]?.lines).toHaveLength(2_000);

		expect(await importProject(file)).toEqual({ created: ["長い"], skipped: [], failed: [] });
		expect(pages()[0]?.lines.map((line) => line.text)).toEqual(["長い", ...lines]);
	});

	it("固定だけできなかったページは、やり直すと、固定する", async () => {
		const { pages } = server();
		const file = buildProjectFile("old", [{ ...page("予定", "本文"), pinned: true }], 0);
		failWhen((url) => url.endsWith("/pin"));

		expect((await importProject(file)).failed).toEqual(["予定"]);
		expect(await importProject(file)).toEqual({ created: ["予定"], skipped: [], failed: [] });
		expect(pages()[0]).toMatchObject({ pinned: true, lines: [{ text: "予定" }, { text: "本文" }] });
	});

	it("同じファイルを読み込み直しても、行は増えない(読み込んであるページは、飛ばす)", async () => {
		const { pages } = server();
		const file = buildProjectFile("old", [page("買い物", "牛乳")], 0);

		await importProject(file);
		expect(await importProject(file)).toEqual({ created: [], skipped: ["買い物"], failed: [] });
		expect(pages()[0]?.lines).toHaveLength(2);
	});

	it("名前と1行目が違うページも、それぞれの名前で戻す(ほかのページの名前を取らない)", async () => {
		// 元のプロジェクト: 「メモ」の1行目は「予定」だが、「予定」が取られていたので、名前が残っていた。
		// 「予定」の1行目は空なので、名前は「予定」のまま。
		const { pages } = server();
		const memo = { ...page("メモ"), lines: ["予定", "本文"] };
		const plan = { ...page("予定"), lines: ["", "予定の本文"], created: 9000 };

		const result = await importProject(buildProjectFile("old", [memo, plan], 0));

		expect(result).toEqual({ created: ["メモ", "予定"], skipped: [], failed: [] });
		expect(pages().map((p) => [p.title, p.lines.map((line) => line.text)])).toEqual([
			["メモ", ["予定", "本文"]],
			["予定", ["", "予定の本文"]],
		]);
	});

	it("1行目の名前のページが台帳に載るのを待ってから、1行目を戻す", async () => {
		const { pages } = server([], { listedAfter: 3 });
		const waits: number[] = [];
		const memo = { ...page("メモ"), lines: ["予定", "本文"] };

		const result = await importProject(
			buildProjectFile("old", [memo, { ...page("予定"), created: 9000 }], 0),
			{
				wait: async (ms) => {
					waits.push(ms);
				},
			},
		);

		expect(result.created).toEqual(["メモ", "予定"]);
		expect(waits).toHaveLength(3);
		expect(pages()[0]?.lines[0]?.text).toBe("予定");
	});

	it("1行目の名前のページを作れなかったか、台帳に載らなければ、1行目を戻さない(名前を取らない)。やり直すと仕上げる", async () => {
		const { pages } = server();
		const memo = { ...page("メモ"), lines: ["予定", "本文"] };
		const plan = { ...page("予定", "予定の本文"), created: 9000 };
		const withBody = buildProjectFile("old", [memo, plan], 0);
		failWhen((url, body) => url.includes("/commits") && body.includes("予定の本文"));

		expect(await importProject(withBody, { wait: async () => {} })).toEqual({
			created: [],
			skipped: [],
			failed: ["メモ", "予定"],
		});
		expect(pages().map((p) => [p.title, p.lines[0]?.text])).toEqual([
			["メモ", "メモ"],
			["予定", undefined],
		]);
		expect(await importProject(withBody, { wait: async () => {} })).toEqual({
			created: ["メモ", "予定"],
			skipped: [],
			failed: [],
		});
		expect(pages().map((p) => [p.title, p.lines[0]?.text])).toEqual([
			["メモ", "予定"],
			["予定", "予定"],
		]);
	});

	it("1行目を戻せなかったページは、やり直すと、1行目だけを戻す", async () => {
		const { pages } = server();
		const file = buildProjectFile("old", [{ ...page("メモ"), lines: ["", "本文"] }], 0);
		failWhen((url, body) => url.includes("/commits") && body.includes('"update"'));

		expect((await importProject(file)).failed).toEqual(["メモ"]);
		expect(pages()[0]?.lines.map((line) => line.text)).toEqual(["メモ", "本文"]);
		expect(await importProject(file)).toEqual({ created: ["メモ"], skipped: [], failed: [] });
		expect(pages()[0]).toMatchObject({ title: "メモ", lines: [{ text: "" }, { text: "本文" }] });
	});

	it("進み具合を、ページごとに知らせる", async () => {
		server();
		const progress: [number, number][] = [];

		await importProject(buildProjectFile("old", [page("一"), page("二")], 0), {
			onProgress: (done, total) => progress.push([done, total]),
		});

		expect(progress).toEqual([
			[1, 2],
			[2, 2],
		]);
	});
});
