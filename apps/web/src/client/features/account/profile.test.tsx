import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "./account.tsx";
import { Profile } from "./profile.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };

function stubServer(user: unknown = hanako, save: () => Response = () => Response.json({})) {
	const server = { user, saved: [] as unknown[] };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method !== "PATCH") return Response.json({ user: server.user, login: ["google"] });
			server.saved.push(JSON.parse(String(init.body)));
			return save();
		}),
	);
	return server;
}

const renderProfile = () =>
	render(
		<AccountProvider>
			<Profile />
		</AccountProvider>,
	);

const nameInput = () =>
	screen.findByRole("textbox", { name: /表示名/ }) as Promise<HTMLInputElement>;
const pictureInput = () =>
	screen.getByRole("textbox", { name: /アイコンの画像のURL/ }) as HTMLInputElement;

describe("Profile(表示名とアイコンを変える)", () => {
	it("ログインの状態が分かるまでは、何も出さない。ログインしていなければ、ログインを求める", async () => {
		stubServer(null);

		const { container } = renderProfile();

		expect(container.textContent).toBe("");
		expect(await screen.findByText(/ログインしてください/)).toBeDefined();
	});

	it("いまの表示名とアイコンを、欄に入れておく。ログインしているアカウントも示す", async () => {
		stubServer({ ...hanako, picture: "https://images.example/a.png" });

		renderProfile();

		expect((await nameInput()).value).toBe("花子");
		expect(pictureInput().value).toBe("https://images.example/a.png");
		expect(screen.getByText(/hanako@example.com/)).toBeDefined();
		expect(screen.getByRole("img", { name: "アイコンの見本" }).getAttribute("src")).toBe(
			"https://images.example/a.png",
		);
		expect(screen.getByText("[花子.icon]")).toBeDefined();
	});

	it("保存すると、表示名とアイコンを送り、ログインの状態を読み直す", async () => {
		const server = stubServer();
		renderProfile();
		fireEvent.change(await nameInput(), { target: { value: "山田 花子" } });
		fireEvent.change(pictureInput(), { target: { value: " https://images.example/b.png " } });

		server.user = { ...hanako, name: "山田 花子", picture: "https://images.example/b.png" };
		fireEvent.click(screen.getByRole("button", { name: "保存する" }));

		expect((await screen.findByRole("status")).textContent).toBe("保存しました");
		expect(server.saved).toEqual([{ name: "山田 花子", picture: "https://images.example/b.png" }]);
		expect(screen.getByText("[山田 花子.icon]")).toBeDefined();
	});

	it("アイコンの欄を空にして保存すると、アイコンをなくす", async () => {
		const server = stubServer({ ...hanako, picture: "https://images.example/a.png" });
		renderProfile();
		await nameInput();

		fireEvent.change(pictureInput(), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "保存する" }));

		await waitFor(() => expect(server.saved).toEqual([{ name: "花子", picture: null }]));
		expect(screen.queryByRole("img", { name: "アイコンの見本" })).toBeNull();
	});

	it.each([
		["invalid-name", /1文字から50文字まで/],
		["invalid-picture", /https:\/\/ で始まるURL/],
		["x", /保存できませんでした/],
	])(
		"保存できなかったとき(%s)は、理由を伝える。直し始めたら、案内を消す",
		async (error, message) => {
			stubServer(hanako, () => Response.json({ error }, { status: 400 }));
			renderProfile();
			const input = await nameInput();

			fireEvent.click(screen.getByRole("button", { name: "保存する" }));

			expect((await screen.findByRole("alert")).textContent).toMatch(message);
			expect(screen.queryByRole("status")).toBeNull();
			fireEvent.change(input, { target: { value: "花子2" } });
			expect(screen.queryByRole("alert")).toBeNull();
		},
	);
});
