import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider, useAccount } from "../account/account.tsx";
import { ProjectGate } from "./project-gate.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const team = { name: "team", visibility: "private", role: "member" };
const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };

function stubServer(project: () => Response, user: unknown = hanako) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			return url === "/api/me" ? Response.json({ user, login: ["google"] }) : project();
		}),
	);
	return urls;
}

/** ログインの状態を読み直すボタン(ログインやログアウトの代わり)。 */
function Refresh() {
	const { refresh } = useAccount();
	return (
		<button type="button" onClick={() => void refresh()}>
			読み直す
		</button>
	);
}

const renderGate = () =>
	render(
		<AccountProvider>
			<ProjectGate name="team">
				{(project) => <p>中身: {project.role ?? "見るだけ"}</p>}
			</ProjectGate>
		</AccountProvider>,
	);

describe("ProjectGate(プロジェクトを読めることを確かめてから、中身を表示する)", () => {
	it("読み込むまでは、そのことを表示する。読めたら、役割を渡して中身を作る", async () => {
		stubServer(() => Response.json(team));

		renderGate();

		expect(screen.getByRole("status").textContent).toBe("読み込んでいます…");
		expect(await screen.findByText("中身: member")).toBeDefined();
	});

	it("メンバーでない人が見られるプロジェクト(公開)では、役割が null になる", async () => {
		stubServer(() => Response.json({ ...team, visibility: "public", role: null }));

		renderGate();

		expect(await screen.findByText("中身: 見るだけ")).toBeDefined();
	});

	it("ない(見る権限がない)プロジェクトでは、そのことを伝え、中身を作らない", async () => {
		stubServer(() => Response.json({ error: "unknown-project" }, { status: 404 }));

		renderGate();

		expect(await screen.findByText(/ないか、見る権限がありません/)).toBeDefined();
		expect(screen.queryByText(/中身/)).toBeNull();
		expect(screen.getByRole("link", { name: "トップ" }).getAttribute("href")).toBe("/");
		// ログインしているので、ログインを勧めない。
		expect(screen.queryByText(/ログインすると/)).toBeNull();
	});

	it("ログインしていない人には、ログインすると見られるかもしれないことを伝える", async () => {
		stubServer(() => Response.json({ error: "unknown-project" }, { status: 404 }), null);

		renderGate();

		expect(await screen.findByText(/ログインすると、見られることがあります/)).toBeDefined();
	});

	it("読み込みに失敗したら、やり直せる", async () => {
		let attempts = 0;
		stubServer(() => {
			attempts += 1;
			return attempts === 1 ? new Response("x", { status: 500 }) : Response.json(team);
		});
		renderGate();

		fireEvent.click(await screen.findByRole("button", { name: "もう一度読み込む" }));

		expect(await screen.findByText("中身: member")).toBeDefined();
	});

	it("ログインの状態が分かってから、1回だけ読み込む", async () => {
		const urls = stubServer(() => Response.json(team));

		renderGate();

		await screen.findByText("中身: member");
		expect(urls).toEqual(["/api/me", "/api/projects/team"]);
	});

	it("ログインの状態が変わったら、読み直す。読み直しているあいだは、前の中身を出したままにする", async () => {
		let user: unknown = hanako;
		let project = () => Response.json(team);
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				return url === "/api/me" ? Response.json({ user, login: ["google"] }) : project();
			}),
		);
		render(
			<AccountProvider>
				<Refresh />
				<ProjectGate name="team">
					{(loaded) => <input aria-label={`中身 ${loaded.role}`} />}
				</ProjectGate>
			</AccountProvider>,
		);
		const input = await screen.findByRole("textbox", { name: "中身 member" });
		fireEvent.change(input, { target: { value: "書きかけ" } });

		// ログアウトした。プロジェクトは、公開なので、読むだけになる。
		user = null;
		project = () => Response.json({ ...team, visibility: "public", role: null });
		fireEvent.click(screen.getByRole("button", { name: "読み直す" }));

		const reloaded = await screen.findByRole("textbox", { name: "中身 null" });
		// 同じ要素のまま(作り直していない)。入力の途中のものが、残っている。
		expect(reloaded).toBe(input);
		expect((reloaded as HTMLInputElement).value).toBe("書きかけ");
		expect(urls.filter((url) => url === "/api/projects/team")).toHaveLength(2);
	});
});
