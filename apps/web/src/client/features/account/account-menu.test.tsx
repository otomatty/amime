import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "./account.tsx";
import { AccountMenu } from "./account-menu.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };

/** /api/me が返す状態を、あとから変えられるようにして、要求を覚えておく。 */
function stubServer(initial: unknown) {
	const server = { state: initial, requests: [] as { url: string; init?: RequestInit }[] };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			server.requests.push(init === undefined ? { url } : { url, init });
			if (url === "/api/me") return Response.json(server.state);
			return new Response(null, { status: 204 });
		}),
	);
	return server;
}

const renderMenu = () =>
	render(
		<AccountProvider>
			<AccountMenu />
		</AccountProvider>,
	);

describe("AccountMenu(ログインの状態と、ログイン・ログアウトの操作)", () => {
	it("状態を読み込むまでは、何も出さない", () => {
		vi.stubGlobal("fetch", () => new Promise(() => {}));

		const { container } = renderMenu();

		expect(container.textContent).toBe("");
	});

	it("ログインしていなければ、Google でログインするリンクを出す。ログインのあと、いまの場所へ戻る", async () => {
		stubServer({ user: null, login: ["google"] });
		window.history.replaceState(null, "", "/買い物?a=1");

		renderMenu();

		const link = await screen.findByRole("link", { name: "Google でログイン" });
		expect(link.getAttribute("href")).toBe(
			`/api/auth/login/google?return=${encodeURIComponent(`/${encodeURIComponent("買い物")}?a=1`)}`,
		);
		expect(screen.queryByRole("button", { name: "ログアウト" })).toBeNull();
	});

	it("ログインの方法がない環境では、何も出さない", async () => {
		const server = stubServer({ user: null, login: [] });

		const { container } = renderMenu();

		await waitFor(() => expect(server.requests).toHaveLength(1));
		expect(container.textContent).toBe("");
	});

	it("ログインしていれば、名前とログアウトのボタンを出す", async () => {
		stubServer({ user: hanako, login: ["google"] });

		renderMenu();

		expect(await screen.findByText("花子")).toBeDefined();
		expect(screen.getByRole("button", { name: "ログアウト" })).toBeDefined();
		expect(screen.queryByRole("link", { name: "Google でログイン" })).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("アイコンの画像があれば、名前の横に出す(画像の置き場所に、いまのページを伝えない)", async () => {
		stubServer({
			user: { ...hanako, picture: "https://images.example/hanako.png" },
			login: ["google"],
		});

		const { container } = renderMenu();

		await screen.findByText("花子");
		const image = container.querySelector("img");
		expect(image?.getAttribute("src")).toBe("https://images.example/hanako.png");
		expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
		// 名前が横にあるので、画像は飾りとして扱う。
		expect(image?.getAttribute("alt")).toBe("");
	});

	it("ログアウトを押すと、ログアウトして、ログインしていない表示に変わる", async () => {
		const server = stubServer({ user: hanako, login: ["google"] });
		renderMenu();
		const button = await screen.findByRole("button", { name: "ログアウト" });

		server.state = { user: null, login: ["google"] };
		fireEvent.click(button);

		expect(await screen.findByRole("link", { name: "Google でログイン" })).toBeDefined();
		expect(server.requests.map((request) => request.url)).toEqual([
			"/api/me",
			"/api/auth/logout",
			"/api/me",
		]);
	});

	it("開発用のログインが使える環境では、名前を入れてログインできる", async () => {
		const server = stubServer({ user: null, login: ["dev"] });
		renderMenu();
		const input = await screen.findByRole("textbox", { name: "開発用ログインの名前" });

		fireEvent.change(input, { target: { value: "hanako" } });
		server.state = { user: { ...hanako, name: "hanako" }, login: ["dev"] };
		fireEvent.click(screen.getByRole("button", { name: "開発用ログイン" }));

		expect(await screen.findByRole("button", { name: "ログアウト" })).toBeDefined();
		expect(server.requests[1]).toEqual({
			url: "/api/auth/dev",
			init: {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "hanako" }),
			},
		});
	});

	it("開発用のログインは、名前が空なら送らない", async () => {
		const server = stubServer({ user: null, login: ["dev"] });
		renderMenu();

		fireEvent.click(await screen.findByRole("button", { name: "開発用ログイン" }));

		expect(server.requests).toHaveLength(1);
	});

	it.each([
		["failed", /ログインできませんでした/],
		["unavailable", /ログインの設定が済んでいません/],
	])("ログインに失敗して戻ってきたとき(?login=%s)は、そのことを伝える", async (reason, message) => {
		stubServer({ user: null, login: ["google"] });
		window.history.replaceState(null, "", `/?login=${reason}`);

		renderMenu();

		expect((await screen.findByRole("alert")).textContent).toMatch(message);
	});

	it("ふつうに開いたときは、失敗の案内を出さない", async () => {
		stubServer({ user: null, login: ["google"] });

		renderMenu();

		await screen.findByRole("link", { name: "Google でログイン" });
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
