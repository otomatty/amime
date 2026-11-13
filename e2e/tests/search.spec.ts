import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const status = (page: Page) => page.getByRole("status");
const search = (page: Page) => page.getByRole("combobox", { name: "ページを探す" });

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

test.describe("名前でページを探す", () => {
	test("名前の一部を入力すると、候補が絞り込まれる。文字が飛び飛びでも見つかり、選ぶとそのページが開く", async ({
		page,
	}) => {
		// 他のテストのページと混ざらないように、このテストだけの語を名前に入れる。
		const token = randomUUID().slice(0, 8);
		await createPage(page, `${token}_買い物_メモ`, "牛乳");
		await createPage(page, `${token}_旅行`, "京都");
		const options = page.getByRole("option");

		// 候補に出るのは、台帳に反映されてから(書き換えが落ち着いてから)。
		await expect(async () => {
			await search(page).fill("");
			await search(page).fill(token);
			await expect(options).toHaveText([`${token} 旅行`, `${token} 買い物 メモ`], {
				timeout: 1000,
			});
		}).toPass();

		// 語を足すと、絞り込まれる。文字が飛び飛びでも合う。
		await search(page).fill(`${token} 買物`);
		await expect(options).toHaveText([`${token} 買い物 メモ`]);

		await search(page).press("Enter");

		await expect(page).toHaveURL(
			new RegExp(`/${token}_${encodeURIComponent("買い物")}_${encodeURIComponent("メモ")}$`),
		);
		await expect(page.getByTestId("line").nth(1)).toHaveAttribute("data-text", "牛乳");
	});

	test("候補は、矢印キーで選べる。合う名前がなければ、そのことが分かる", async ({ page }) => {
		const token = randomUUID().slice(0, 8);
		await createPage(page, `${token}-a`, "1つめ");
		await createPage(page, `${token}-b`, "2つめ");
		const options = page.getByRole("option");
		await expect(async () => {
			await search(page).fill("");
			await search(page).fill(token);
			await expect(options).toHaveCount(2, { timeout: 1000 });
		}).toPass();

		await search(page).press("ArrowDown");
		await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
		const chosen = await options.nth(1).textContent();
		await search(page).press("Enter");
		await expect(page).toHaveURL(new RegExp(`/${chosen}$`));

		await search(page).fill(`${token} どこにもない名前`);
		await expect(page.getByText("合う名前のページはありません")).toBeVisible();
	});
});
