import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };
const team = { name: "team", visibility: "private", role: "member" };

type Replies = Record<string, () => Response>;

/** URLごとに応答を決める、サーバーの代わり。決めていないURLには、404 を返す。呼ばれたURLを覚えておく。 */
function stubServer(replies: Replies = {}) {
	const defaults: Replies = {
		"/api/me": () => Response.json({ user: hanako, login: ["google"] }),
		"/api/projects": () => Response.json({ projects: [team], canCreate: false }),
		"/api/projects/team": () => Response.json(team),
		"/api/projects/team/pages/titles?q=": () => Response.json({ titles: [] }),
	};
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			const reply = { ...defaults, ...replies }[url];
			return reply ? reply() : Response.json({ error: "not-found" }, { status: 404 });
		}),
	);
	return urls;
}

const open = (path: string) => window.history.replaceState(null, "", path);

describe("App", () => {
	it("プロダクト名を見出しとして表示し、そこからトップへ移れる", () => {
		stubServer();
		open("/");

		render(<App />);

		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Amime");
		expect(screen.getByRole("link", { name: "Amime" }).getAttribute("href")).toBe("/");
	});

	it("ヘッダーに、ログインの状態を表示する", async () => {
		stubServer();
		open("/");

		const { container } = render(<App />);

		const header = container.querySelector(".app-header");
		await waitFor(() => expect(header?.textContent).toContain("花子"));
		expect(screen.getByRole("button", { name: "ログアウト" })).toBeDefined();
	});

	describe("トップ(/)", () => {
		it("ログインしていれば、参加しているプロジェクトを並べる", async () => {
			stubServer();
			open("/");

			render(<App />);

			const link = await screen.findByRole("link", { name: "team" });
			expect(link.getAttribute("href")).toBe("/team/");
			// プロジェクトの中ではないので、ページを探す欄は出さない。
			expect(screen.queryByRole("combobox", { name: "ページを探す" })).toBeNull();
		});

		it("ログインしていなければ、案内と、試し書きのページへのリンクを出す(プロジェクトの一覧は、読み込まない)", async () => {
			const urls = stubServer({
				"/api/me": () => Response.json({ user: null, login: ["google"] }),
			});
			open("/");

			render(<App />);

			const link = await screen.findByRole("link", { name: "試し書きのページ" });
			expect(link.getAttribute("href")).toBe("/?playground");
			expect(urls).toEqual(["/api/me"]);
		});

		it("URLに ?playground を付けると、保存されない試し書きのページを表示する", async () => {
			const urls = stubServer();
			open("/?playground");

			render(<App />);

			expect(screen.getByText(/この画面は試し書き用です/)).toBeDefined();
			expect(screen.getAllByTestId("line").length).toBeGreaterThan(1);
			await waitFor(() => expect(urls).toEqual(["/api/me"]));
		});
	});

	describe("プロジェクトのトップ(/プロジェクト/)", () => {
		it("ページの一覧を表示する。ヘッダーに、プロジェクトの名前と、ページを探す欄を出す", async () => {
			stubServer({
				"/api/projects/team/pages?sort=updated&offset=0": () =>
					Response.json({ pages: [], total: 0 }),
			});
			open("/team/");

			render(<App />);

			await waitFor(() => expect(screen.getByText(/まだページがありません/)).toBeDefined());
			expect(screen.getByRole("region", { name: "ページの一覧" })).toBeDefined();
			expect(screen.getByRole("link", { name: "team" }).getAttribute("href")).toBe("/team/");
			expect(screen.getByRole("textbox", { name: "新しいページの名前" })).toBeDefined();
			await waitFor(() =>
				expect(screen.getByRole("combobox", { name: "ページを探す" })).toBeDefined(),
			);
		});

		it("末尾に / のないURLは、/ を付けたURLにそろえる(ページへのリンクが、同じ階層を指すように)", () => {
			stubServer();
			open("/team?sort=title#x");

			render(<App />);

			const { pathname, search, hash } = window.location;
			expect(`${pathname}${search}${hash}`).toBe("/team/?sort=title#x");
		});

		it("URLに ?q= で語が付いていれば、本文を探した結果を表示する(一覧は読み込まない)", async () => {
			const search = `/api/projects/team/pages/search?q=${encodeURIComponent("牛乳")}`;
			const urls = stubServer({ [search]: () => Response.json({ hits: [], more: false }) });
			open(`/team/?q=${encodeURIComponent("牛乳")}`);

			render(<App />);

			await waitFor(() => expect(screen.getByText(/を含むページはありません/)).toBeDefined());
			expect(urls).not.toContain("/api/projects/team/pages?sort=updated&offset=0");
		});

		it("メンバーでない人(公開のプロジェクトを見ている人)には、新しいページを作る欄を出さない", async () => {
			stubServer({
				"/api/projects/team": () => Response.json({ ...team, visibility: "public", role: null }),
				"/api/projects/team/pages?sort=updated&offset=0": () =>
					Response.json({ pages: [], total: 0 }),
			});
			open("/team/");

			render(<App />);

			await screen.findByRole("region", { name: "ページの一覧" });
			expect(screen.queryByRole("textbox", { name: "新しいページの名前" })).toBeNull();
		});

		it("ないプロジェクト(見る権限のないプロジェクトも同じ)では、そのことを伝える。中身は読み込まない", async () => {
			const urls = stubServer({
				"/api/projects/team": () => Response.json({ error: "unknown-project" }, { status: 404 }),
			});
			open("/team/");

			render(<App />);

			expect(await screen.findByText(/ないか、見る権限がありません/)).toBeDefined();
			expect(urls.filter((url) => url.includes("/pages?"))).toEqual([]);
		});
	});

	describe("ページ(/プロジェクト/ページ)", () => {
		it("そのプロジェクトの、その名前のページを読み込む", async () => {
			const urls = stubServer();
			open(`/team/${encodeURIComponent("買い物")}`);

			render(<App />);

			await waitFor(() =>
				expect(urls).toContain(`/api/projects/team/pages/by-title/${encodeURIComponent("買い物")}`),
			);
		});

		it("メンバーでない人には、読むだけの表示にする", async () => {
			const info = { id: "p1", title: "買い物", problem: null, pinned: false };
			stubServer({
				"/api/projects/team": () => Response.json({ ...team, visibility: "public", role: null }),
				[`/api/projects/team/pages/by-title/${encodeURIComponent("買い物")}`]: () =>
					Response.json(info),
				"/api/projects/team/pages/p1": () =>
					Response.json({ version: 1, lines: [{ id: "a", text: "買い物" }] }),
				"/api/projects/team/pages/p1/links": () =>
					Response.json({ missing: [], related: [], hops: [] }),
			});
			open(`/team/${encodeURIComponent("買い物")}`);

			render(<App />);

			await waitFor(() =>
				expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true"),
			);
		});
	});
});
