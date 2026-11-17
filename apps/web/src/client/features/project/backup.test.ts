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
		expect(calls.filter((call) => call.url.includes("?sort="))).toHaveLength(2);
		expect(progress.at(-1)).toEqual([101, 101]);
	});

	it("一覧に出たあとで消されたページ(本文が空)は、書き出さない", async () => {
		stubServer((url) => {
			if (url.includes("?sort=")) return json({ pages: [card("gone", "消えた")], total: 1 });
			return json({ version: 0, lines: [] });
		});

		expect((await exportProject("team", { now: () => 0 })).pages).toEqual([]);
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

	/** まだないページ(本文が空)を開き、送られたコミットを受け付けるサーバー。exists の名前は、もうある。 */
	function server(exists: readonly string[] = []) {
		const ids = new Map<string, string>();
		const openByTitle = (title: string) => {
			const id = `id-${ids.size}`;
			ids.set(id, title);
			return json({ id, title, problem: null, pinned: false });
		};
		const load = (id: string) => {
			const title = ids.get(id) ?? "";
			return exists.includes(title)
				? json({ version: 4, lines: [{ id: "x", text: title }] })
				: json({ version: 0, lines: [] });
		};
		return stubServer((url, init) => {
			const byTitle = /\/pages\/by-title\/([^/?]+)$/.exec(url)?.[1];
			if (byTitle !== undefined)
				return openByTitle(decodeURIComponent(byTitle).replaceAll("_", " "));
			if (/\/pages\/[^/]+\/commits$/.test(url) && init?.method === "POST")
				return json({ version: 1, applied: JSON.parse(String(init.body)).changes });
			const pin = /\/pages\/([^/]+)\/pin$/.exec(url)?.[1];
			if (pin !== undefined)
				return json({ id: pin, title: ids.get(pin), problem: null, pinned: true });
			const id = /\/pages\/([^/]+)$/.exec(url)?.[1];
			return id === undefined ? undefined : load(id);
		});
	}

	it("まだない名前のページを作り、すべての行を送る。固定していたページは、固定する", async () => {
		const calls = server();
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
		const calls = server(["買い物"]);

		const result = await importProject(
			buildProjectFile("old", [page("買い物", "牛乳"), page("予定")], 0),
		);

		expect(result).toEqual({ created: ["予定"], skipped: ["買い物"], failed: [] });
		expect(calls.filter((call) => call.url.endsWith("/commits"))).toHaveLength(1);
	});

	it("送れなかったページは、失敗として知らせ、ほかのページは続ける", async () => {
		server();
		const failing = vi.mocked(fetch);
		const original = failing.getMockImplementation();
		failing.mockImplementation(async (url, init) => {
			if (String(url).includes("/commits") && String(init?.body).includes("壊れる")) {
				return json({ error: "unavailable" }, 503);
			}
			return original?.(url, init) ?? json({}, 500);
		});

		const result = await importProject(buildProjectFile("old", [page("壊れる"), page("予定")], 0));

		expect(result.created).toEqual(["予定"]);
		expect(result.failed).toEqual(["壊れる"]);
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
