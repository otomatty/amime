import type { PageId } from "@amime/sync";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTools } from "./page-tools.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const id = "p-1" as PageId;
const info = (pinned: boolean) => ({ id, title: "買い物", problem: null, pinned });

function stubFetch(respond: () => Response) {
	const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond());
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("PageTools(ページの操作)", () => {
	describe("一覧の先頭への固定", () => {
		it("固定していないページでは、固定するボタンを出す。押すと固定し、固定したことを知らせる", async () => {
			const fetchMock = stubFetch(() => json(info(true)));
			const onPinned = vi.fn();
			render(<PageTools id={id} pinned={false} onPinned={onPinned} />);
			const button = screen.getByRole("button", { name: "一覧の先頭に固定する" });
			expect(button.getAttribute("aria-pressed")).toBe("false");

			fireEvent.click(button);

			await waitFor(() => expect(onPinned).toHaveBeenCalledExactlyOnceWith(true));
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("/api/projects/team/pages/p-1/pin");
			expect(JSON.parse(String(init?.body))).toEqual({ pinned: true });
		});

		it("固定しているページでは、固定を外すボタンを出す。押すと外す", async () => {
			stubFetch(() => json(info(false)));
			const onPinned = vi.fn();
			render(<PageTools id={id} pinned={true} onPinned={onPinned} />);
			const button = screen.getByRole("button", { name: "固定を外す" });
			expect(button.getAttribute("aria-pressed")).toBe("true");

			fireEvent.click(button);

			await waitFor(() => expect(onPinned).toHaveBeenCalledExactlyOnceWith(false));
		});

		it("固定できなかったら、そのことを伝える。固定したとは知らせない", async () => {
			stubFetch(() => json({ error: "x" }, 500));
			const onPinned = vi.fn();
			render(<PageTools id={id} pinned={false} onPinned={onPinned} />);

			fireEvent.click(screen.getByRole("button", { name: "一覧の先頭に固定する" }));

			await waitFor(() =>
				expect(screen.getByRole("alert").textContent).toBe(
					"できませんでした。少し待ってから、もう一度試してください。",
				),
			);
			expect(onPinned).not.toHaveBeenCalled();
		});
	});

	describe("削除", () => {
		it("削除のボタンを押しただけでは、削除しない。元に戻せないことを伝えて、確かめる", () => {
			const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
			render(<PageTools id={id} pinned={false} onPinned={vi.fn()} />);

			fireEvent.click(screen.getByRole("button", { name: "このページを削除" }));

			expect(screen.getByText(/削除すると、元には戻せません/)).toBeDefined();
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("確かめたあとで「削除する」を押すと、削除して、トップへ移る", async () => {
			const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
			const navigate = vi.fn();
			render(<PageTools id={id} pinned={false} onPinned={vi.fn()} navigate={navigate} />);
			fireEvent.click(screen.getByRole("button", { name: "このページを削除" }));

			fireEvent.click(screen.getByRole("button", { name: "削除する" }));

			await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("./"));
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("/api/projects/team/pages/p-1");
			expect(init?.method).toBe("DELETE");
		});

		it("「やめる」を押すと、削除せずに、元の表示に戻る", () => {
			const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
			render(<PageTools id={id} pinned={false} onPinned={vi.fn()} />);
			fireEvent.click(screen.getByRole("button", { name: "このページを削除" }));

			fireEvent.click(screen.getByRole("button", { name: "やめる" }));

			expect(screen.queryByText(/元には戻せません/)).toBeNull();
			expect(screen.getByRole("button", { name: "このページを削除" })).toBeDefined();
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("削除できなかったら、そのことを伝える。トップへは移らない", async () => {
			stubFetch(() => json({ error: "x" }, 500));
			const navigate = vi.fn();
			render(<PageTools id={id} pinned={false} onPinned={vi.fn()} navigate={navigate} />);
			fireEvent.click(screen.getByRole("button", { name: "このページを削除" }));

			fireEvent.click(screen.getByRole("button", { name: "削除する" }));

			await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
			expect(navigate).not.toHaveBeenCalled();
		});
	});
});
