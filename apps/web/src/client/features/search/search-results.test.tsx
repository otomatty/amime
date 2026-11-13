import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchResults } from "./search-results.tsx";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hit = (id: string, title: string, ...lines: string[]) => ({
	id,
	title,
	updated: Date.UTC(2026, 10, 13, 1, 30),
	lines,
});

function stubSearch(respond: (query: string) => Response | Promise<Response>) {
	const fetchMock = vi.fn(async (url: string) =>
		respond(new URL(url, "https://amime.test").searchParams.get("q") ?? ""),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const marked = (element: HTMLElement) =>
	Array.from(element.querySelectorAll("mark"), (mark) => mark.textContent);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("SearchResults(本文を探した結果)", () => {
	it("探しているあいだは、そのことを表示する。何を探したかが、見出しで分かる", () => {
		stubSearch(() => new Promise(() => {}));

		render(<SearchResults query="牛乳 卵" />);

		expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
			"「牛乳 卵」を本文から探した結果",
		);
		expect(screen.getByRole("status").textContent).toBe("探しています…");
	});

	it("見つかったページを並べる。名前から、そのページを開ける。語を含む行を添え、語に印を付ける", async () => {
		const fetchMock = stubSearch(() =>
			json({
				hits: [hit("p1", "買い物 メモ", "牛乳を2本買う", "卵と牛乳"), hit("p2", "牛乳の話")],
				more: false,
			}),
		);

		render(<SearchResults query="牛乳" />);

		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/projects/team/pages/search?q=${encodeURIComponent("牛乳")}`,
			undefined,
		);
		const [first, second] = screen.getAllByRole("listitem");
		if (!first || !second) throw new Error("no results");
		expect(within(first).getByRole("link", { name: "買い物 メモ" }).getAttribute("href")).toBe(
			`./${encodeURIComponent("買い物_メモ")}`,
		);
		expect(within(first).getByText("を2本買う", { exact: false }).textContent).toBe(
			"牛乳を2本買う",
		);
		expect(marked(first)).toEqual(["牛乳", "牛乳"]);
		// 名前に語があれば、名前にも印を付ける。
		expect(marked(second)).toEqual(["牛乳"]);
		expect(first.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-13T01:30:00.000Z");
	});

	it("見つからなければ、そのことを伝える", async () => {
		stubSearch(() => json({ hits: [], more: false }));

		render(<SearchResults query="どこにもない言葉" />);

		await waitFor(() =>
			expect(screen.getByText("「どこにもない言葉」を含むページはありません。")).toBeDefined(),
		);
	});

	it("ほかにも合うページがあるときは、語を足して絞り込むように案内する", async () => {
		stubSearch(() => json({ hits: [hit("p1", "メモ", "牛乳")], more: true }));

		render(<SearchResults query="牛乳" />);

		await waitFor(() => expect(screen.getByText(/ほかにも、合うページがあります/)).toBeDefined());
	});

	it("探せなかったら、そのことを伝える。もう一度探せる", async () => {
		let failing = true;
		stubSearch(() =>
			failing
				? json({ error: "x" }, 500)
				: json({ hits: [hit("p1", "メモ", "牛乳")], more: false }),
		);
		render(<SearchResults query="牛乳" />);
		await waitFor(() => expect(screen.getByText(/探せませんでした/)).toBeDefined());

		failing = false;
		fireEvent.click(screen.getByRole("button", { name: "もう一度探す" }));

		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
	});

	it("権限がないときは、代わりの内容を表示する(探せなかった、とは言わない)", async () => {
		stubSearch(() => json({ error: "read-only" }, 403));

		render(<SearchResults query="牛乳" whenDisabled={<p>代わりの内容</p>} />);

		await waitFor(() => expect(screen.getByText("代わりの内容")).toBeDefined());
		expect(screen.queryByText(/探せませんでした/)).toBeNull();
		expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
	});

	it("探す語が変わったら、探し直す。あとから届いた前の結果は、使わない", async () => {
		let releaseOld: (response: Response) => void = () => {};
		stubSearch((query) =>
			query === "古い"
				? new Promise<Response>((resolve) => {
						releaseOld = resolve;
					})
				: json({ hits: [hit("p2", "新しい結果")], more: false }),
		);
		const { rerender } = render(<SearchResults query="古い" />);

		rerender(<SearchResults query="新しい" />);
		await waitFor(() => expect(screen.getByRole("link", { name: "新しい結果" })).toBeDefined());
		releaseOld(json({ hits: [hit("p1", "古い結果")], more: false }));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByRole("link", { name: "古い結果" })).toBeNull();
	});
});
