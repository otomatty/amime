import type { PageCard, PageId } from "@amime/sync";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PageCards } from "./page-card.tsx";

const card = (id: string, title: string, extra: Partial<PageCard> = {}): PageCard => ({
	id: id as PageId,
	title,
	descriptions: [],
	image: null,
	updated: Date.UTC(2026, 10, 13, 1, 30),
	created: Date.UTC(2026, 10, 1),
	linked: 0,
	pinned: false,
	...extra,
});

afterEach(cleanup);

describe("PageCards(ページのカードの並び)", () => {
	it("ページごとに、名前・冒頭の本文・更新した時刻を見せる。押すと、そのページを開く", () => {
		render(<PageCards pages={[card("p1", "買い物 メモ", { descriptions: ["牛乳", "卵"] })]} />);

		const item = screen.getByRole("listitem");
		expect(within(item).getByRole("heading", { level: 2 }).textContent).toBe("買い物 メモ");
		expect(within(item).getByRole("link").getAttribute("href")).toBe(
			`./${encodeURIComponent("買い物_メモ")}`,
		);
		expect(within(item).getByText("牛乳")).toBeDefined();
		expect(within(item).getByText("卵")).toBeDefined();
		expect(item.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-13T01:30:00.000Z");
	});

	it("画像があれば見せる。読み込み先には、見ているページのURLを伝えない", () => {
		render(<PageCards pages={[card("p1", "写真", { image: "https://example.com/a.png" })]} />);

		const image = screen.getByRole("listitem").querySelector("img");
		expect(image?.getAttribute("src")).toBe("https://example.com/a.png");
		expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("固定しているページには、その印を出す", () => {
		render(<PageCards pages={[card("p1", "固定した", { pinned: true }), card("p2", "ふつう")]} />);

		const [first, second] = screen.getAllByRole("listitem");
		if (!first || !second) throw new Error("no cards");
		expect(within(first).getByText("固定")).toBeDefined();
		expect(within(second).queryByText("固定")).toBeNull();
	});

	it("カードの並びに見出しを付けるときは、名前の見出しを1つ下の段階にできる", () => {
		render(<PageCards pages={[card("p1", "買い物")]} heading="h3" />);

		expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("買い物");
	});
});
