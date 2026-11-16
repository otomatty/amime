import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PendingPages } from "./pending-pages.tsx";

/** 端末内に残した記録。 */
function leave(id: string, title: string, savedAt: number, project = "team") {
	window.localStorage.setItem(
		`tsuzuri:pending:${id}:tab`,
		JSON.stringify({
			savedAt,
			entries: [{ inflight: null, changes: [{ type: "delete", id: "a" }] }],
			page: { project, id, title },
		}),
	);
}

afterEach(() => {
	cleanup();
	window.localStorage.clear();
});

describe("PendingPages(この端末に、送れていない変更があるページ。ADR-0042)", () => {
	it("このプロジェクトのページを、新しく残した順に、IDで開くリンクにして並べる", () => {
		const now = Date.now();
		leave("p1", "古いメモ", now - 2000);
		leave("p2", "新しいメモ", now - 1000);
		leave("p3", "別のプロジェクト", now, "other");

		render(<PendingPages />);

		const section = screen.getByRole("region", {
			name: "この端末に、送れていない変更があるページ",
		});
		const links = within(section).getAllByRole("link");
		expect(links.map((link) => link.textContent)).toEqual(["新しいメモ", "古いメモ"]);
		expect(links.map((link) => link.getAttribute("href"))).toEqual(["./?page=p2", "./?page=p1"]);
	});

	it("残っている記録がなければ、何も出さない", () => {
		const { container } = render(<PendingPages />);

		expect(container.innerHTML).toBe("");
	});
});
