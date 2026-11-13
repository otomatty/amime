import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageList } from "./page-list.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const card = (id: string, title: string, extra: object = {}) => ({
	id,
	title,
	descriptions: [],
	image: null,
	updated: Date.UTC(2026, 10, 13, 1, 30),
	created: Date.UTC(2026, 10, 1),
	linked: 0,
	pinned: false,
	...extra,
});

/** 一覧のAPIの代わり。呼ばれたURLを記録する。 */
function stubList(respond: (url: URL) => Response | Promise<Response>) {
	const fetchMock = vi.fn(async (input: string) => respond(new URL(input, "https://amime.test")));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const cards = () => screen.getAllByRole("listitem");
const titles = () => cards().map((item) => within(item).getByRole("heading").textContent);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

describe("PageList(ページの一覧)", () => {
	it("読み込んでいるあいだは、そのことを表示する", () => {
		stubList(() => new Promise(() => {}));

		render(<PageList />);

		expect(screen.getByRole("status").textContent).toBe("読み込んでいます…");
	});

	it("ページをカードとして並べる。名前・冒頭の本文・画像・更新した時刻が見える", async () => {
		stubList(() =>
			json({
				pages: [
					card("p1", "買い物 メモ", {
						descriptions: ["牛乳", "卵"],
						image: "https://example.com/a.png",
					}),
					card("p2", "献立"),
				],
				total: 2,
			}),
		);

		render(<PageList />);

		await waitFor(() => expect(titles()).toEqual(["買い物 メモ", "献立"]));
		const [first, second] = cards();
		if (!first || !second) throw new Error("no cards");
		expect(within(first).getByRole("link").getAttribute("href")).toBe(
			`./${encodeURIComponent("買い物_メモ")}`,
		);
		expect(within(first).getByText("牛乳")).toBeDefined();
		expect(within(first).getByText("卵")).toBeDefined();
		const image = first.querySelector("img");
		expect(image?.getAttribute("src")).toBe("https://example.com/a.png");
		// 画像の置き場所に、見ているページのURLを伝えない。
		expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(first.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-13T01:30:00.000Z");
		expect(second.querySelector("img")).toBeNull();
	});

	it("一覧の先頭に固定しているページには、その印を出す", async () => {
		stubList(() =>
			json({
				pages: [card("p1", "固定したページ", { pinned: true }), card("p2", "ふつうのページ")],
				total: 2,
			}),
		);

		render(<PageList />);

		await waitFor(() => expect(titles()).toEqual(["固定したページ", "ふつうのページ"]));
		const [first, second] = cards();
		if (!first || !second) throw new Error("no cards");
		expect(within(first).getByText("固定")).toBeDefined();
		expect(within(second).queryByText("固定")).toBeNull();
	});

	it("ページがなければ、最初のページの作り方を案内する", async () => {
		stubList(() => json({ pages: [], total: 0 }));

		render(<PageList />);

		await waitFor(() => expect(screen.getByText(/まだページがありません/)).toBeDefined());
		expect(screen.queryByRole("listitem")).toBeNull();
	});

	it("はじめは、更新が新しい順で取り出す", async () => {
		const fetchMock = stubList(() => json({ pages: [], total: 0 }));

		render(<PageList />);

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/team/pages?sort=updated&offset=0");
	});

	it("並び順を選ぶと、その順で取り出し直す。選んだ並び順は、URLに残る", async () => {
		const fetchMock = stubList((url) =>
			json({
				pages: [
					card("p1", url.searchParams.get("sort") === "title" ? "名前順の先頭" : "更新順の先頭"),
				],
				total: 1,
			}),
		);
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["更新順の先頭"]));

		fireEvent.change(screen.getByLabelText("並び順"), { target: { value: "title" } });

		await waitFor(() => expect(titles()).toEqual(["名前順の先頭"]));
		expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/projects/team/pages?sort=title&offset=0");
		expect(window.location.search).toBe("?sort=title");
	});

	it("URLに並び順があれば、その順で始める。知らない並び順は、更新が新しい順として扱う", async () => {
		window.history.replaceState(null, "", "/team/?sort=linked");
		const fetchMock = stubList(() => json({ pages: [], total: 0 }));
		const { unmount } = render(<PageList />);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/team/pages?sort=linked&offset=0");
		expect(screen.getByLabelText<HTMLSelectElement>("並び順").value).toBe("linked");
		unmount();

		window.history.replaceState(null, "", "/team/?sort=popular");
		const second = render(<PageList />);

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/projects/team/pages?sort=updated&offset=0");
		second.unmount();

		// どのオブジェクトにもある名前(toString など)も、並び順としては知らない値。
		window.history.replaceState(null, "", "/team/?sort=toString");
		render(<PageList />);

		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/projects/team/pages?sort=updated&offset=0");
	});

	it("まだ取り出していないページがあれば、続きを取り出せる", async () => {
		const fetchMock = stubList((url) =>
			url.searchParams.get("offset") === "0"
				? json({ pages: [card("p1", "1つめ"), card("p2", "2つめ")], total: 3 })
				: json({ pages: [card("p3", "3つめ")], total: 3 }),
		);
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ"]));

		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));

		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ", "3つめ"]));
		expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/projects/team/pages?sort=updated&offset=2");
		expect(screen.queryByRole("button", { name: "もっと見る" })).toBeNull();
	});

	it("続きを取り出すあいだに増えたページと重なっても、同じページを2度並べない", async () => {
		stubList((url) =>
			url.searchParams.get("offset") === "0"
				? json({ pages: [card("p1", "1つめ"), card("p2", "2つめ")], total: 3 })
				: json({ pages: [card("p2", "2つめ"), card("p3", "3つめ")], total: 4 }),
		);
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ"]));

		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));

		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ", "3つめ"]));
	});

	it("続きは、サーバーから受け取った件数の次から取り出す(重なった分を数え直さない)。最後まで取り出したら終わる", async () => {
		// 取り出しているあいだに、先頭にページが増えた。サーバーの並びは [X, 1つめ, 2つめ, 3つめ] になっている。
		const fetchMock = stubList((url) => {
			const offset = url.searchParams.get("offset");
			if (offset === "0")
				return json({ pages: [card("p1", "1つめ"), card("p2", "2つめ")], total: 3 });
			if (offset === "2")
				return json({ pages: [card("p2", "2つめ"), card("p3", "3つめ")], total: 4 });
			return json({ pages: [], total: 4 });
		});
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ"]));

		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));

		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ", "3つめ"]));
		// 受け取ったのは4件。総数も4件なので、続きはない。
		expect(screen.queryByRole("button", { name: "もっと見る" })).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("続きが1件も返ってこなければ、そこで終わりにする", async () => {
		stubList((url) =>
			url.searchParams.get("offset") === "0"
				? json({ pages: [card("p1", "1つめ")], total: 5 })
				: json({ pages: [], total: 5 }),
		);
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["1つめ"]));

		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));

		await waitFor(() => expect(screen.queryByRole("button", { name: "もっと見る" })).toBeNull());
	});

	it("続きを取り出しているあいだに「もっと見る」をもう一度押しても、同じ続きを2度は取り出さない", async () => {
		let releaseMore: (response: Response) => void = () => {};
		const fetchMock = stubList((url) => {
			const offset = url.searchParams.get("offset");
			if (offset === "0") return json({ pages: [card("p1", "1つめ")], total: 3 });
			if (offset === "2") return json({ pages: [card("p3", "3つめ")], total: 3 });
			return new Promise<Response>((resolve) => {
				releaseMore = resolve;
			});
		});
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["1つめ"]));
		const more = screen.getByRole("button", { name: "もっと見る" });

		fireEvent.click(more);
		fireEvent.click(more);
		releaseMore(json({ pages: [card("p2", "2つめ")], total: 3 }));

		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ"]));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// 続きの位置は1件分だけ進む。3つめのページまで、取りこぼさずにたどり着ける。
		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));
		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ", "3つめ"]));
		expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/projects/team/pages?sort=updated&offset=2");
	});

	it("続きを取り出せなかったら、もう一度「もっと見る」を押して取り出せる", async () => {
		let failing = true;
		stubList((url) => {
			if (url.searchParams.get("offset") === "0")
				return json({ pages: [card("p1", "1つめ")], total: 2 });
			return failing ? json({ error: "x" }, 500) : json({ pages: [card("p2", "2つめ")], total: 2 });
		});
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["1つめ"]));
		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "もっと見る" })).toHaveProperty("disabled", false),
		);

		failing = false;
		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));

		await waitFor(() => expect(titles()).toEqual(["1つめ", "2つめ"]));
	});

	it("続きを取り出しているあいだに並び順を変えたら、前の並び順の続きは捨てる", async () => {
		let releaseMore: (response: Response) => void = () => {};
		stubList((url) => {
			if (url.searchParams.get("offset") !== "0") {
				return new Promise<Response>((resolve) => {
					releaseMore = resolve;
				});
			}
			return url.searchParams.get("sort") === "title"
				? json({ pages: [card("t1", "名前順の先頭")], total: 2 })
				: json({ pages: [card("u1", "更新順の先頭")], total: 2 });
		});
		render(<PageList />);
		await waitFor(() => expect(titles()).toEqual(["更新順の先頭"]));
		fireEvent.click(screen.getByRole("button", { name: "もっと見る" }));

		fireEvent.change(screen.getByLabelText("並び順"), { target: { value: "title" } });
		await waitFor(() => expect(titles()).toEqual(["名前順の先頭"]));
		releaseMore(json({ pages: [card("u2", "更新順の続き")], total: 2 }));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(titles()).toEqual(["名前順の先頭"]);
	});

	it("名前を入れて「作る」を押すと、その名前のページへ移る", async () => {
		stubList(() => json({ pages: [], total: 0 }));
		const navigate = vi.fn();
		render(<PageList navigate={navigate} />);

		fireEvent.change(screen.getByLabelText("新しいページの名前"), {
			target: { value: "  新しい ページ " },
		});
		fireEvent.click(screen.getByRole("button", { name: "作る" }));

		expect(navigate).toHaveBeenCalledExactlyOnceWith(`./${encodeURIComponent("新しい_ページ")}`);
	});

	it.each([[""], ["   "], ["."], [".."]])("名前にできない入力 %j では、移らない", (value) => {
		stubList(() => json({ pages: [], total: 0 }));
		const navigate = vi.fn();
		render(<PageList navigate={navigate} />);

		fireEvent.change(screen.getByLabelText("新しいページの名前"), { target: { value } });
		fireEvent.click(screen.getByRole("button", { name: "作る" }));

		expect(navigate).not.toHaveBeenCalled();
	});

	it("取り出せなかったら、そのことを表示する。やり直せる", async () => {
		let failing = true;
		stubList(() =>
			failing ? json({ error: "x" }, 500) : json({ pages: [card("p1", "買い物")], total: 1 }),
		);
		render(<PageList />);
		await waitFor(() => expect(screen.getByText(/一覧を読み込めませんでした/)).toBeDefined());

		failing = false;
		fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));

		await waitFor(() => expect(titles()).toEqual(["買い物"]));
	});

	it("権限がないときは、代わりの内容を表示する", async () => {
		stubList(() => json({ error: "read-only" }, 403));

		render(<PageList whenDisabled={<p>代わりの内容</p>} />);

		await waitFor(() => expect(screen.getByText("代わりの内容")).toBeDefined());
	});
	it("読むだけの表示では、新しいページを作る欄を出さない(並び順は選べる)", async () => {
		stubList(() => json({ pages: [], total: 0 }));

		render(<PageList readOnly />);

		await waitFor(() => expect(screen.getByText(/まだページがありません/)).toBeDefined());
		expect(screen.queryByRole("textbox", { name: "新しいページの名前" })).toBeNull();
		expect(screen.getByRole("combobox", { name: "並び順" })).toBeDefined();
		// ない欄へ、案内しない。
		expect(screen.queryByText(/上の欄に名前を入れて/)).toBeNull();
	});
});
