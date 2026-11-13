import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/account.tsx";
import { Home } from "./home.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };
const team = { name: "team", visibility: "private", role: "admin" };

type Options = {
	readonly user?: unknown;
	readonly list?: () => Response;
	readonly create?: () => Response;
};

function stubServer({ user = hanako, list, create }: Options = {}) {
	const requests: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			requests.push(init === undefined ? { url } : { url, init });
			if (url === "/api/me") return Response.json({ user, login: ["google"] });
			if (init?.method === "POST")
				return (create ?? (() => Response.json(team, { status: 201 })))();
			return (list ?? (() => Response.json({ projects: [], canCreate: false })))();
		}),
	);
	return requests;
}

function renderHome() {
	const navigate = vi.fn();
	render(
		<AccountProvider>
			<Home navigate={navigate} />
		</AccountProvider>,
	);
	return navigate;
}

const listOf =
	(projects: unknown[], canCreate = false) =>
	() =>
		Response.json({ projects, canCreate });

describe("Home(トップ。参加しているプロジェクトの一覧)", () => {
	it("ログインの状態が分かるまでは、何も出さない", () => {
		vi.stubGlobal("fetch", () => new Promise(() => {}));

		const { container } = render(
			<AccountProvider>
				<Home />
			</AccountProvider>,
		);

		expect(container.textContent).toBe("");
	});

	it("ログインしていなければ、案内と、試し書きのページへのリンクを出す", async () => {
		const requests = stubServer({ user: null });

		renderHome();

		expect(
			await screen.findByText(/ログインすると、参加しているプロジェクトが並びます/),
		).toBeDefined();
		expect(screen.getByRole("link", { name: "試し書きのページ" }).getAttribute("href")).toBe(
			"/?playground",
		);
		expect(requests.map((request) => request.url)).toEqual(["/api/me"]);
	});

	it("参加しているプロジェクトを、公開範囲と一緒に並べる", async () => {
		stubServer({ list: listOf([team, { name: "open", visibility: "public", role: "member" }]) });

		renderHome();

		expect((await screen.findByRole("link", { name: "team" })).getAttribute("href")).toBe("/team/");
		expect(screen.getByRole("link", { name: "open" }).getAttribute("href")).toBe("/open/");
		const items = screen.getAllByRole("listitem").map((item) => item.textContent);
		expect(items).toEqual(["team非公開", "open公開"]);
	});

	it("参加しているプロジェクトがなければ、招待リンクで参加できることを伝える", async () => {
		stubServer();

		renderHome();

		expect(await screen.findByText(/招待リンクを受け取ると、参加できます/)).toBeDefined();
	});

	it("一覧を読み込めなかったら、そのことを伝える", async () => {
		stubServer({ list: () => new Response("x", { status: 500 }) });

		renderHome();

		expect(await screen.findByText(/一覧を読み込めませんでした/)).toBeDefined();
	});

	it("作る権限のない人には、プロジェクトを作る欄を出さない", async () => {
		stubServer({ list: listOf([team]) });

		renderHome();

		await screen.findByRole("link", { name: "team" });
		expect(screen.queryByRole("button", { name: "プロジェクトを作る" })).toBeNull();
	});

	describe("プロジェクトを作る", () => {
		const fill = async (name: string) => {
			fireEvent.change(await screen.findByRole("textbox", { name: /名前/ }), {
				target: { value: name },
			});
		};

		it("名前と公開範囲を入れて作ると、そのプロジェクトへ移る", async () => {
			const requests = stubServer({
				list: listOf([], true),
				create: () =>
					Response.json({ name: "my-team", visibility: "public", role: "admin" }, { status: 201 }),
			});
			const navigate = renderHome();
			await fill(" my-team ");
			fireEvent.change(screen.getByRole("combobox", { name: "公開範囲" }), {
				target: { value: "public" },
			});

			fireEvent.click(screen.getByRole("button", { name: "プロジェクトを作る" }));

			await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/my-team/"));
			expect(requests.at(-1)?.init?.body).toBe(
				JSON.stringify({ name: "my-team", visibility: "public" }),
			);
		});

		it("公開範囲は、選ばなければ非公開", async () => {
			const requests = stubServer({ list: listOf([], true) });
			renderHome();
			await fill("my-team");

			fireEvent.click(screen.getByRole("button", { name: "プロジェクトを作る" }));

			await waitFor(() =>
				expect(requests.at(-1)?.init?.body).toBe(
					JSON.stringify({ name: "my-team", visibility: "private" }),
				),
			);
		});

		it("名前が空なら、送らない", async () => {
			const requests = stubServer({ list: listOf([], true) });
			renderHome();
			await fill("  ");

			fireEvent.click(screen.getByRole("button", { name: "プロジェクトを作る" }));

			expect(requests.filter((request) => request.init?.method === "POST")).toEqual([]);
		});

		it.each([
			["name-taken", /すでにあります/],
			["invalid-name", /半角の英小文字・数字・ハイフン/],
			["reserved-name", /その名前は、使えません/],
			["not-allowed", /作る権限がありません/],
			["login-required", /ログインしてから/],
			["unknown", /作れませんでした/],
		])("作れなかったとき(%s)は、理由を伝える。名前を直すと、案内を消す", async (error, message) => {
			stubServer({
				list: listOf([], true),
				create: () => Response.json({ error }, { status: 400 }),
			});
			const navigate = renderHome();
			await fill("my-team");

			fireEvent.click(screen.getByRole("button", { name: "プロジェクトを作る" }));

			expect((await screen.findByRole("alert")).textContent).toMatch(message);
			expect(navigate).not.toHaveBeenCalled();
			await fill("my-team-2");
			expect(screen.queryByRole("alert")).toBeNull();
		});
	});
});
