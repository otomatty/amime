import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleSearch } from "./title-search.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 名前で探すAPIの代わり。入力(q)ごとの応答を決める。 */
function stubTitles(respond: (query: string) => Response | Promise<Response>) {
	const fetchMock = vi.fn(async (url: string) =>
		respond(new URL(url, "https://amime.test").searchParams.get("q") ?? ""),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const input = () => screen.getByRole("combobox", { name: "ページを探す" });
const options = () => screen.queryAllByRole("option").map((option) => option.textContent);
const active = () =>
	screen.queryAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")
		?.textContent ?? null;
const typeQuery = (value: string) => fireEvent.change(input(), { target: { value } });

/** 探す欄が出るのを待つ(出るのは、ページのAPIが使えると分かってから)。 */
async function renderSearch(navigate = vi.fn()) {
	render(<TitleSearch navigate={navigate} />);
	await waitFor(() => expect(input()).toBeDefined());
	return navigate;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("TitleSearch(名前でページを探す)", () => {
	it("ページのAPIが無効な環境では、探す欄を出さない", async () => {
		const fetchMock = stubTitles(() => json({ error: "page-api-disabled" }, 403));

		render(<TitleSearch />);

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it("入力するたびに、合う名前の候補を出す。いちばん合う候補を選んだ状態にする", async () => {
		stubTitles((query) => json({ titles: query === "買" ? ["買い物", "買い物 メモ"] : [] }));
		await renderSearch();
		expect(input().getAttribute("aria-expanded")).toBe("false");

		typeQuery("買");

		await waitFor(() => expect(options()).toEqual(["買い物", "買い物 メモ"]));
		expect(input().getAttribute("aria-expanded")).toBe("true");
		expect(active()).toBe("買い物");
		expect(input().getAttribute("aria-activedescendant")).toBe(
			screen.getAllByRole("option")[0]?.id,
		);
	});

	it("Enter で、選んでいる候補のページを開く", async () => {
		stubTitles(() => json({ titles: ["買い物 メモ", "旅行"] }));
		const navigate = await renderSearch();
		typeQuery("メモ");
		await waitFor(() => expect(options()).toHaveLength(2));

		fireEvent.keyDown(input(), { key: "Enter" });

		expect(navigate).toHaveBeenCalledExactlyOnceWith(`./${encodeURIComponent("買い物_メモ")}`);
	});

	it("上下の矢印キーで、候補を選び直せる。端まで行くと、反対の端に回る", async () => {
		stubTitles(() => json({ titles: ["一", "二", "三"] }));
		const navigate = await renderSearch();
		typeQuery("x");
		await waitFor(() => expect(options()).toHaveLength(3));

		fireEvent.keyDown(input(), { key: "ArrowDown" });
		expect(active()).toBe("二");
		fireEvent.keyDown(input(), { key: "ArrowUp" });
		fireEvent.keyDown(input(), { key: "ArrowUp" });
		expect(active()).toBe("三");
		fireEvent.keyDown(input(), { key: "ArrowDown" });
		expect(active()).toBe("一");
		fireEvent.keyDown(input(), { key: "ArrowDown" });
		fireEvent.keyDown(input(), { key: "Enter" });

		expect(navigate).toHaveBeenCalledExactlyOnceWith(`./${encodeURIComponent("二")}`);
	});

	it("候補を押すと、そのページを開く", async () => {
		stubTitles(() => json({ titles: ["買い物", "旅行"] }));
		const navigate = await renderSearch();
		typeQuery("x");
		await waitFor(() => expect(options()).toHaveLength(2));

		fireEvent.mouseDown(screen.getByRole("option", { name: "旅行" }));

		expect(navigate).toHaveBeenCalledExactlyOnceWith(`./${encodeURIComponent("旅行")}`);
	});

	it("Esc で、候補を閉じる。もう1度入力すると、また出る", async () => {
		stubTitles(() => json({ titles: ["買い物"] }));
		const navigate = await renderSearch();
		typeQuery("買");
		await waitFor(() => expect(options()).toHaveLength(1));

		fireEvent.keyDown(input(), { key: "Escape" });

		expect(options()).toEqual([]);
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(navigate).not.toHaveBeenCalled();
		typeQuery("買い");
		await waitFor(() => expect(options()).toHaveLength(1));
	});

	it("欄から離れると、候補を閉じる。戻ると、また出る", async () => {
		stubTitles(() => json({ titles: ["買い物"] }));
		await renderSearch();
		typeQuery("買");
		await waitFor(() => expect(options()).toHaveLength(1));

		fireEvent.blur(input());
		expect(options()).toEqual([]);

		fireEvent.focus(input());
		expect(options()).toEqual(["買い物"]);
	});

	it("何も入力していないときは、最近更新したページを候補にする", async () => {
		stubTitles((query) => json({ titles: query === "" ? ["最近のページ"] : [] }));
		await renderSearch();

		fireEvent.focus(input());

		await waitFor(() => expect(options()).toEqual(["最近のページ"]));
	});

	it("合う名前がなければ、そのことを伝える。Enter では、どこにも移らない", async () => {
		stubTitles((query) => json({ titles: query === "" ? ["最近のページ"] : [] }));
		const navigate = await renderSearch();

		typeQuery("ない名前");

		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toBe("合う名前のページはありません"),
		);
		expect(options()).toEqual([]);
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(navigate).not.toHaveBeenCalled();
	});

	it("あとから届いた、前の入力への応答で、いまの候補を上書きしない", async () => {
		let releaseOld: (response: Response) => void = () => {};
		stubTitles((query) => {
			if (query === "古") {
				return new Promise<Response>((resolve) => {
					releaseOld = resolve;
				});
			}
			return json({ titles: query === "新" ? ["新しい入力の候補"] : [] });
		});
		await renderSearch();
		typeQuery("古");
		await waitFor(() => expect(releaseOld).not.toBe(undefined));
		await new Promise((resolve) => setTimeout(resolve, 200));

		typeQuery("新");
		await waitFor(() => expect(options()).toEqual(["新しい入力の候補"]));
		releaseOld(json({ titles: ["古い入力の候補"] }));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(options()).toEqual(["新しい入力の候補"]);
	});

	it("日本語入力の変換を確定する Enter では、ページを開かない", async () => {
		stubTitles(() => json({ titles: ["買い物"] }));
		const navigate = await renderSearch();
		typeQuery("かいもの");
		await waitFor(() => expect(options()).toHaveLength(1));

		fireEvent.keyDown(input(), { key: "Enter", isComposing: true });

		expect(navigate).not.toHaveBeenCalled();
	});

	it("探すのに失敗しても、欄は使い続けられる", async () => {
		let failing = false;
		stubTitles(() => (failing ? json({ error: "x" }, 500) : json({ titles: ["買い物"] })));
		await renderSearch();
		failing = true;
		typeQuery("買");
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(options()).toEqual([]);

		failing = false;
		typeQuery("買い");

		await waitFor(() => expect(options()).toEqual(["買い物"]));
	});
});
