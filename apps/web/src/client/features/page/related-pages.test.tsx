import type { PageCard, PageId, PageLinks } from "@amime/sync";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RelatedPages } from "./related-pages.tsx";

const card = (id: string, title: string): PageCard => ({
	id: id as PageId,
	title,
	descriptions: [],
	image: null,
	updated: Date.UTC(2026, 10, 13),
	created: Date.UTC(2026, 10, 1),
	linked: 0,
	pinned: false,
});
const links = (extra: Partial<PageLinks>): PageLinks => ({
	missing: [],
	related: [],
	hops: [],
	...extra,
});
const groups = () => screen.getAllByRole("group");
const titlesIn = (group: HTMLElement) =>
	within(group)
		.getAllByRole("listitem")
		.map((item) => within(item).getByRole("heading").textContent);

afterEach(cleanup);

describe("RelatedPages(関連するページ)", () => {
	it("つながっているページがなければ、何も出さない", () => {
		const { container } = render(<RelatedPages links={links({ missing: ["まだない"] })} />);

		expect(container.textContent).toBe("");
	});

	it("リンクしているページと、リンクされているページを、カードで並べる", () => {
		render(<RelatedPages links={links({ related: [card("p1", "料理"), card("p2", "旅行")] })} />);

		expect(screen.getByRole("region", { name: "関連するページ" })).toBeDefined();
		const [direct] = groups();
		if (!direct) throw new Error("no group");
		expect(within(direct).getByRole("heading", { level: 3 }).textContent).toBe(
			"このページとつながっているページ",
		);
		expect(titlesIn(direct)).toEqual(["料理", "旅行"]);
	});

	it("同じリンクを持つページを、リンク先ごとにまとめる。まとまりの見出しから、リンク先を開ける", () => {
		render(
			<RelatedPages
				links={links({
					hops: [
						{
							title: "料理 メモ",
							exists: true,
							pages: [card("p1", "カレー"), card("p2", "パスタ")],
						},
						{ title: "旅行", exists: false, pages: [card("p3", "京都")] },
					],
				})}
			/>,
		);

		const [cooking, travel] = groups();
		if (!cooking || !travel) throw new Error("no groups");
		const heading = within(cooking).getByRole("heading", { level: 3 });
		expect(heading.textContent).toBe("「料理 メモ」にもリンクしているページ");
		expect(within(heading).getByRole("link").getAttribute("href")).toBe(
			`./${encodeURIComponent("料理_メモ")}`,
		);
		expect(titlesIn(cooking)).toEqual(["カレー", "パスタ"]);
		expect(titlesIn(travel)).toEqual(["京都"]);
	});

	it("まだないページへのリンクのまとまりは、見出しのリンクに印を付ける", () => {
		render(
			<RelatedPages
				links={links({
					hops: [
						{ title: "料理", exists: true, pages: [card("p1", "カレー")] },
						{ title: "旅行", exists: false, pages: [card("p3", "京都")] },
					],
				})}
			/>,
		);

		expect(screen.getByRole("link", { name: "料理" }).hasAttribute("data-missing")).toBe(false);
		expect(screen.getByRole("link", { name: "旅行" }).getAttribute("data-missing")).toBe("true");
	});
});
