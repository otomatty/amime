import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/account.tsx";
import { ProjectSettings } from "./settings.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };
const taro = {
	id: "u2",
	name: "太郎",
	picture: "https://x.example/taro.png",
	role: "member",
	joined: 2000,
};
const admin = { id: "u1", name: "花子", picture: null, role: "admin", joined: 1000 };
const invite = { id: "i1", created: Date.UTC(2026, 0, 1), expires: Date.UTC(2026, 0, 8) };
const team = { name: "team", visibility: "private", role: "admin" } as const;

type Server = {
	members: unknown;
	replies: Record<string, () => Response | Promise<Response>>;
	requests: { url: string; method: string; body: unknown }[];
};

function stubServer(members: unknown = { members: [admin, taro], invites: [invite] }): Server {
	const server: Server = { members, replies: {}, requests: [] };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			if (url === "/api/me") return Response.json({ user: hanako, login: ["google"] });
			if (method === "GET") {
				return server.members === null
					? new Response("x", { status: 500 })
					: Response.json(server.members);
			}
			server.requests.push({
				url,
				method,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			return (server.replies[`${method} ${url}`] ?? (() => new Response(null, { status: 204 })))();
		}),
	);
	return server;
}

function renderSettings(project: { name: string; visibility: string; role: string | null } = team) {
	const navigate = vi.fn();
	render(
		<AccountProvider>
			<ProjectSettings
				project={project as never}
				navigate={navigate}
				origin="https://amime.example"
			/>
		</AccountProvider>,
	);
	return navigate;
}

const memberItems = async () =>
	within(await screen.findByRole("list", { name: "メンバー" })).getAllByRole("listitem");

describe("ProjectSettings(プロジェクトの設定)", () => {
	it("メンバーでない人には、設定を出さない", () => {
		stubServer();

		renderSettings({ ...team, visibility: "public", role: null });

		expect(screen.getByText(/メンバーだけです/)).toBeDefined();
		expect(screen.queryByRole("heading", { name: "メンバー" })).toBeNull();
	});

	it("メンバーを、参加した順に並べる。ページの一覧へ戻れる", async () => {
		stubServer();

		renderSettings();

		const items = await memberItems();
		expect(items.map((item) => item.textContent)).toEqual([
			expect.stringContaining("花子(自分)"),
			expect.stringContaining("太郎"),
		]);
		expect(screen.getByRole("link", { name: "ページの一覧へ戻る" }).getAttribute("href")).toBe(
			"/team/",
		);
	});

	it("メンバーを読み込めなかったら、そのことを伝える", async () => {
		stubServer(null);

		renderSettings();

		expect(await screen.findByText(/メンバーを読み込めませんでした/)).toBeDefined();
	});

	describe("管理者", () => {
		it("公開範囲を変えられる", async () => {
			const server = stubServer();
			renderSettings();
			const select = screen.getByRole("combobox", { name: "公開範囲" }) as HTMLSelectElement;
			expect(select.value).toBe("private");

			fireEvent.change(select, { target: { value: "public" } });

			await waitFor(() => expect(select.value).toBe("public"));
			expect(server.requests).toEqual([
				{ url: "/api/projects/team", method: "PATCH", body: { visibility: "public" } },
			]);
		});

		it("公開範囲を変えられなかったら、表示を変えず、そのことを伝える", async () => {
			const server = stubServer();
			server.replies["PATCH /api/projects/team"] = () =>
				Response.json({ error: "not-admin" }, { status: 403 });
			renderSettings();
			const select = screen.getByRole("combobox", { name: "公開範囲" }) as HTMLSelectElement;

			fireEvent.change(select, { target: { value: "public" } });

			expect((await screen.findByRole("alert")).textContent).toMatch(/管理者だけができます/);
			expect(select.value).toBe("private");
		});

		it("メンバーの役割を変えられる。変えたら、一覧を読み直す", async () => {
			const server = stubServer();
			renderSettings();
			const role = await screen.findByRole("combobox", { name: "太郎 の役割" });

			server.members = { members: [admin, { ...taro, role: "admin" }], invites: [] };
			fireEvent.change(role, { target: { value: "admin" } });

			await waitFor(() =>
				expect(
					(screen.getByRole("combobox", { name: "太郎 の役割" }) as HTMLSelectElement).value,
				).toBe("admin"),
			);
			expect(server.requests).toEqual([
				{ url: "/api/projects/team/members/u2", method: "PUT", body: { role: "admin" } },
			]);
		});

		it("最後の管理者をメンバーに戻そうとしたら、できない理由を伝える", async () => {
			const server = stubServer();
			server.replies["PUT /api/projects/team/members/u1"] = () =>
				Response.json({ error: "last-admin" }, { status: 409 });
			renderSettings();

			fireEvent.change(await screen.findByRole("combobox", { name: "花子 の役割" }), {
				target: { value: "member" },
			});

			expect((await screen.findByRole("alert")).textContent).toMatch(/管理者が1人だけのとき/);
		});

		it("メンバーを外せる", async () => {
			const server = stubServer();
			const navigate = renderSettings();

			server.members = { members: [admin], invites: [] };
			fireEvent.click(await screen.findByRole("button", { name: "太郎 を外す" }));

			await waitFor(async () => expect(await memberItems()).toHaveLength(1));
			expect(server.requests).toEqual([
				{ url: "/api/projects/team/members/u2", method: "DELETE", body: null },
			]);
			expect(navigate).not.toHaveBeenCalled();
		});

		it("知らない理由で失敗したときは、やり直しを案内する", async () => {
			const server = stubServer();
			server.replies["DELETE /api/projects/team/members/u2"] = () =>
				new Response("x", { status: 500 });
			renderSettings();

			fireEvent.click(await screen.findByRole("button", { name: "太郎 を外す" }));

			expect((await screen.findByRole("alert")).textContent).toMatch(/変更できませんでした/);
		});

		it("招待リンクを作ると、その場でだけ、リンクを表示する", async () => {
			const server = stubServer();
			const created = { id: "i2", created: 1, expires: 2, token: "tok-en_1" };
			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json(created, { status: 201 });
			renderSettings();

			fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));

			const input = (await screen.findByRole("textbox", {
				name: /新しい招待リンク/,
			})) as HTMLInputElement;
			expect(input.value).toBe("https://amime.example/invite/tok-en_1");
			expect(input.readOnly).toBe(true);
		});

		it("招待リンクを作ったあとで、一覧の読み直しに失敗しても、作ったリンクは表示したままにする", async () => {
			const server = stubServer();
			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json({ id: "i2", created: 1, expires: 2, token: "tok-en_1" }, { status: 201 });
			renderSettings();
			const button = await screen.findByRole("button", { name: "招待リンクを作る" });

			// 作ったあとの、一覧の読み直しが失敗する。
			server.members = null;
			fireEvent.click(button);

			const input = (await screen.findByRole("textbox", {
				name: /新しい招待リンク/,
			})) as HTMLInputElement;
			expect(input.value).toBe("https://amime.example/invite/tok-en_1");
			// 前に読み込んだメンバーも、出したままにする。
			expect(await memberItems()).toHaveLength(2);
		});

		it("招待リンクを作ったあとで、もう一度作ろうとして失敗しても、前に作ったリンクは表示したままにする", async () => {
			const server = stubServer();
			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json({ id: "i2", created: 1, expires: 2, token: "first" }, { status: 201 });
			renderSettings();
			fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));
			await screen.findByRole("textbox", { name: /新しい招待リンク/ });

			server.replies["POST /api/projects/team/invites"] = () => new Response("x", { status: 500 });
			fireEvent.click(screen.getByRole("button", { name: "招待リンクを作る" }));

			await screen.findByRole("alert");
			const input = screen.getByRole("textbox", { name: /新しい招待リンク/ }) as HTMLInputElement;
			expect(input.value).toBe("https://amime.example/invite/first");
		});

		it("作ったばかりのリンクを無効にできなかったら、リンクは表示したままにする(まだ使えるリンクを、見失わせない)", async () => {
			const server = stubServer({ members: [admin], invites: [invite] });
			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json({ ...invite, token: "tok" }, { status: 201 });
			server.replies["DELETE /api/projects/team/invites/i1"] = () =>
				new Response("x", { status: 500 });
			renderSettings();
			fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));
			await screen.findByRole("textbox", { name: /新しい招待リンク/ });

			fireEvent.click(screen.getByRole("button", { name: "無効にする" }));

			await screen.findByRole("alert");
			expect(screen.getByRole("textbox", { name: /新しい招待リンク/ })).toBeDefined();
		});

		it("リンクを無効にしているあいだに、別のリンクを作ったら、無効にし終えても、新しいリンクは表示したままにする", async () => {
			const server = stubServer({ members: [admin], invites: [invite] });
			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json({ ...invite, token: "old" }, { status: 201 });
			let finish: (response: Response) => void = () => {};
			server.replies["DELETE /api/projects/team/invites/i1"] = () =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				});
			renderSettings();
			fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));
			await screen.findByDisplayValue("https://amime.example/invite/old");
			fireEvent.click(screen.getByRole("button", { name: "無効にする" }));

			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json({ ...invite, id: "i2", token: "new" }, { status: 201 });
			fireEvent.click(screen.getByRole("button", { name: "招待リンクを作る" }));
			await screen.findByDisplayValue("https://amime.example/invite/new");
			finish(new Response(null, { status: 204 }));

			await waitFor(() => expect(server.requests).toHaveLength(3));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(screen.getByDisplayValue("https://amime.example/invite/new")).toBeDefined();
		});

		it("自分をメンバーに戻したあとで、一覧を読み直せなくても、管理者だけの操作を出すのをやめる", async () => {
			const second = { ...taro, role: "admin" };
			const server = stubServer({ members: [admin, second], invites: [invite] });
			renderSettings();
			const role = await screen.findByRole("combobox", { name: "花子 の役割" });

			server.members = null;
			fireEvent.change(role, { target: { value: "member" } });

			await waitFor(() =>
				expect(screen.queryByRole("combobox", { name: "花子 の役割" })).toBeNull(),
			);
			expect(screen.queryByRole("heading", { name: "招待リンク" })).toBeNull();
			expect(screen.queryByRole("button", { name: "太郎 を外す" })).toBeNull();
		});

		it("メンバーを外したあとで、一覧を読み直せなくても、外した人は一覧から消す", async () => {
			const server = stubServer();
			renderSettings();
			const remove = await screen.findByRole("button", { name: "太郎 を外す" });

			server.members = null;
			fireEvent.click(remove);

			await waitFor(() => expect(screen.queryByRole("button", { name: "太郎 を外す" })).toBeNull());
			expect(await memberItems()).toHaveLength(1);
		});

		it("自分をメンバーに戻したら、管理者だけの操作(役割の変更、招待リンク)を出すのをやめる", async () => {
			const second = { ...taro, role: "admin" };
			const server = stubServer({ members: [admin, second], invites: [invite] });
			renderSettings();
			const role = await screen.findByRole("combobox", { name: "花子 の役割" });

			server.members = { members: [{ ...admin, role: "member" }, second], invites: [] };
			fireEvent.change(role, { target: { value: "member" } });

			await waitFor(() =>
				expect(screen.queryByRole("combobox", { name: "花子 の役割" })).toBeNull(),
			);
			expect(screen.queryByRole("heading", { name: "招待リンク" })).toBeNull();
			expect(screen.queryByRole("combobox", { name: "公開範囲" })).toBeNull();
			expect(screen.queryByRole("button", { name: "太郎 を外す" })).toBeNull();
			// 自分で抜けることは、できる。
			expect(screen.getByRole("button", { name: "このプロジェクトから抜ける" })).toBeDefined();
		});

		it("招待リンクを作れなかったら、そのことを伝える", async () => {
			const server = stubServer();
			server.replies["POST /api/projects/team/invites"] = () => new Response("x", { status: 500 });
			renderSettings();

			fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));

			expect((await screen.findByRole("alert")).textContent).toMatch(/変更できませんでした/);
			expect(screen.queryByRole("textbox", { name: /新しい招待リンク/ })).toBeNull();
		});

		it("使える招待リンクを並べ、無効にできる。作ったばかりのリンクを無効にしたら、表示も消す", async () => {
			const server = stubServer({ members: [admin], invites: [] });
			server.replies["POST /api/projects/team/invites"] = () =>
				Response.json({ ...invite, token: "tok" }, { status: 201 });
			renderSettings();
			server.members = { members: [admin], invites: [invite] };
			fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));
			const list = await screen.findByRole("list", { name: "使える招待リンク" });
			expect(within(list).getAllByRole("listitem")).toHaveLength(1);
			await screen.findByRole("textbox", { name: /新しい招待リンク/ });

			server.members = { members: [admin], invites: [] };
			fireEvent.click(within(list).getByRole("button", { name: "無効にする" }));

			await waitFor(() =>
				expect(screen.queryByRole("list", { name: "使える招待リンク" })).toBeNull(),
			);
			expect(screen.queryByRole("textbox", { name: /新しい招待リンク/ })).toBeNull();
			expect(server.requests.at(-1)).toEqual({
				url: "/api/projects/team/invites/i1",
				method: "DELETE",
				body: null,
			});
		});
	});

	describe("管理者でないメンバー", () => {
		const asMember = () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					if (url === "/api/me") {
						return Response.json({ user: { ...hanako, id: "u2", name: "太郎" }, login: [] });
					}
					if (init?.method === "DELETE") return new Response(null, { status: 204 });
					return Response.json({ members: [admin, taro], invites: [] });
				}),
			);
		};

		it("公開範囲と役割は、見るだけ。招待リンクの欄は、出さない", async () => {
			asMember();

			renderSettings({ ...team, role: "member" });

			await memberItems();
			expect(screen.queryByRole("combobox")).toBeNull();
			expect(screen.getByText("非公開(メンバーだけが見られる)")).toBeDefined();
			expect(screen.queryByRole("heading", { name: "招待リンク" })).toBeNull();
			expect(screen.queryByRole("button", { name: /を外す/ })).toBeNull();
		});

		it("自分は、プロジェクトから抜けられる。抜けたら、トップへ移る", async () => {
			asMember();
			const navigate = renderSettings({ ...team, role: "member" });

			fireEvent.click(await screen.findByRole("button", { name: "このプロジェクトから抜ける" }));

			await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/"));
		});
	});
});
