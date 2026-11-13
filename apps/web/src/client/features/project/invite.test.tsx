import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/account.tsx";
import { InvitePage } from "./invite.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };
const target = { project: "team", member: false };

type Options = {
	readonly user?: unknown;
	readonly invite?: () => Response;
	readonly accept?: () => Response;
};

function stubServer({ user = hanako, invite, accept }: Options = {}) {
	const requests: { url: string; method: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			requests.push({ url, method: init?.method ?? "GET" });
			if (url === "/api/me") return Response.json({ user, login: ["google"] });
			if (init?.method === "POST") {
				return (accept ?? (() => Response.json({ ...target, member: true })))();
			}
			return (invite ?? (() => Response.json(target)))();
		}),
	);
	return requests;
}

function renderInvite() {
	const navigate = vi.fn();
	window.history.replaceState(null, "", "/invite/tok-1");
	render(
		<AccountProvider>
			<InvitePage token="tok-1" navigate={navigate} />
		</AccountProvider>,
	);
	return navigate;
}

describe("InvitePage(招待リンクを開いたときの画面)", () => {
	it("招待先を確かめて、だれとして参加するかを示す。参加すると、プロジェクトへ移る", async () => {
		const requests = stubServer();
		const navigate = renderInvite();
		expect(screen.getByRole("status").textContent).toBe("読み込んでいます…");

		expect(await screen.findByRole("heading", { name: "「team」への招待" })).toBeDefined();
		expect(screen.getByText(/花子 として、このプロジェクトに参加します/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "参加する" }));

		await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/team/"));
		expect(requests).toEqual([
			{ url: "/api/me", method: "GET" },
			{ url: "/api/invites/tok-1", method: "GET" },
			{ url: "/api/invites/tok-1/accept", method: "POST" },
		]);
	});

	it("ログインしていなければ、ログインを求める。ログインのあと、この招待リンクへ戻る", async () => {
		stubServer({ user: null });

		renderInvite();

		const link = await screen.findByRole("link", { name: "Google でログインして参加する" });
		expect(link.getAttribute("href")).toBe(
			`/api/auth/login/google?return=${encodeURIComponent("/invite/tok-1")}`,
		);
		expect(screen.queryByRole("button", { name: "参加する" })).toBeNull();
	});

	it("もうメンバーなら、参加のボタンを出さず、プロジェクトへのリンクを出す", async () => {
		stubServer({ invite: () => Response.json({ ...target, member: true }) });

		renderInvite();

		const link = await screen.findByRole("link", { name: "プロジェクトを開く" });
		expect(link.getAttribute("href")).toBe("/team/");
		expect(screen.queryByRole("button", { name: "参加する" })).toBeNull();
	});

	it("使えないリンク(無効、期限切れ)なら、そのことを伝える", async () => {
		stubServer({ invite: () => Response.json({ error: "unknown-invite" }, { status: 404 }) });

		renderInvite();

		expect(await screen.findByText(/この招待リンクは、使えません/)).toBeDefined();
	});

	it("確かめられなかったら、そのことを伝える", async () => {
		stubServer({ invite: () => new Response("x", { status: 500 }) });

		renderInvite();

		expect(await screen.findByText(/確かめられませんでした/)).toBeDefined();
	});

	it("参加しようとしたときに、リンクが使えなくなっていたら、そのことを伝える", async () => {
		stubServer({ accept: () => Response.json({ error: "unknown-invite" }, { status: 404 }) });
		const navigate = renderInvite();

		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));

		expect(await screen.findByText(/この招待リンクは、使えません/)).toBeDefined();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("参加に失敗したら、やり直せるように、そのことを伝える", async () => {
		stubServer({ accept: () => new Response("x", { status: 500 }) });
		const navigate = renderInvite();

		fireEvent.click(await screen.findByRole("button", { name: "参加する" }));

		expect((await screen.findByRole("alert")).textContent).toMatch(/参加できませんでした/);
		expect(screen.getByRole("button", { name: "参加する" })).toBeDefined();
		expect(navigate).not.toHaveBeenCalled();
	});
});
