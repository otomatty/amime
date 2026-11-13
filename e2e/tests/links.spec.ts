import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const newPageName = () => `e2e-${randomUUID()}`;
const status = (page: Page) => page.getByRole("status");
const related = (page: Page) => page.getByRole("region", { name: "関連するページ" });

/** 指定した行の末尾の余白を押して、カーソルを行末に置く。 */
async function clickLineEnd(page: Page, index: number) {
	const box = await page.getByTestId("line").nth(index).boundingBox();
	if (!box) throw new Error(`line ${index} is not visible`);
	await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
}

/** 本文のあるページを作る。 */
async function createPage(page: Page, name: string, ...body: string[]) {
	await page.goto(`/${name}`);
	await clickLineEnd(page, 0);
	for (const text of body) {
		await page.keyboard.press("Enter");
		await page.keyboard.type(text);
	}
	await expect(status(page)).toHaveText("保存済み");
}

test.describe("リンクでつながる", () => {
	test("まだないページへのリンクは、見た目で区別できる。開くと、その名前で書き始められ、どこから参照されているかが分かる", async ({
		page,
	}) => {
		const from = newPageName();
		const to = newPageName();
		await createPage(page, from, `[${to}] を読む`);
		// カーソルを1行目に移す(リンクのある行を、編集中でなくする)。
		await clickLineEnd(page, 0);
		const link = page.getByRole("link", { name: to });

		// 台帳に反映されると(書き換えが落ち着いてから)、まだないページへのリンクだと分かる。
		await expect(link).toHaveAttribute("data-missing", "true");
		await link.click();

		await expect(page).toHaveURL(new RegExp(`/${to}$`));
		await expect(page.getByTestId("line").first()).toHaveAttribute("data-text", to);
		await expect(status(page)).toHaveText("新しいページです。書き始めると保存されます");
		// まだ書いていないページでも、このページへリンクしているページが並ぶ。
		await expect(related(page).getByRole("heading", { name: from })).toBeVisible();

		// 書くと、ページができる。元のページのリンクは、ふつうのリンクになる。
		await clickLineEnd(page, 0);
		await page.keyboard.press("Enter");
		await page.keyboard.type("書いた");
		await expect(status(page)).toHaveText("保存済み");
		// 元のページには、リンク先のページが、関連するページとして並ぶ。
		await expect(async () => {
			await page.goto(`/${from}`);
			await expect(related(page).getByRole("heading", { name: to })).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect(page.locator("[data-missing]")).toHaveCount(0);
	});

	test("同じリンクを持つページが、リンク先ごとにまとまって並ぶ(2ホップ先)", async ({ page }) => {
		const topic = newPageName();
		const first = newPageName();
		const second = newPageName();
		await createPage(page, first, `#${topic} の話`);
		await createPage(page, second, `これも [${topic}]`);

		// 2つめのページが台帳に反映されると、1つめのページにも出る。
		await expect(async () => {
			await page.goto(`/${first}`);
			await expect(related(page)).toBeVisible({ timeout: 1000 });
		}).toPass();
		const group = related(page).getByRole("group");
		await expect(group.getByRole("heading", { level: 3 })).toHaveText(
			`「${topic}」にもリンクしているページ`,
		);
		await expect(group.getByRole("listitem").getByRole("heading")).toHaveText([second]);
		// まとまりの見出しから、リンク先(まだないページ)を開ける。
		const heading = group.getByRole("heading", { level: 3 }).getByRole("link");
		await expect(heading).toHaveAttribute("data-missing", "true");
		await heading.click();
		await expect(page).toHaveURL(new RegExp(`/${topic}$`));
		await expect(related(page).getByRole("listitem").getByRole("heading")).toHaveText([
			second,
			first,
		]);
	});
});
