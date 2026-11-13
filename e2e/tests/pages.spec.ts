import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const newPageName = () => `e2e-${randomUUID()}`;
const status = (page: Page) => page.getByRole("status");
const cards = (page: Page) => page.getByRole("listitem");
const cardOf = (page: Page, name: string) => cards(page).filter({ hasText: name });

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

/**
 * 一覧の続きを、最後まで取り出す。
 * 手元では、前の実行で作ったページが残っている。目当てのページが、最初のひとまとまりに入るとは限らない。
 */
async function showAllCards(page: Page) {
	const more = page.getByRole("button", { name: "もっと見る" });
	await cards(page).first().waitFor();
	while (await more.isVisible()) {
		const count = await cards(page).count();
		await more.click();
		// 続きが並ぶか、続きがなくなる(ボタンが消える)のを待つ。
		await expect
			.poll(async () => (await cards(page).count()) > count || !(await more.isVisible()))
			.toBe(true);
	}
}

test.describe("ページの一覧", () => {
	test("作ったページが、トップにカードとして並ぶ。冒頭の本文が見え、押すと開く", async ({
		page,
	}) => {
		const name = newPageName();
		await createPage(page, name, "牛乳を [買う]", "`code` も読める");

		// 一覧に載るのは、書き換えが落ち着いてから。
		await expect(async () => {
			await page.goto("/");
			await expect(cardOf(page, name)).toBeVisible({ timeout: 1000 });
		}).toPass();
		const card = cardOf(page, name);
		await expect(card.getByRole("heading")).toHaveText(name);
		await expect(card).toContainText("牛乳を 買う");
		await expect(card).toContainText("code も読める");

		await card.getByRole("link").click();

		await expect(page).toHaveURL(new RegExp(`/${name}$`));
		await expect(page.getByTestId("line").first()).toHaveAttribute("data-text", name);
	});

	test("更新が新しい順に並ぶ。並び順を変えられ、選んだ順は再読み込みしても残る", async ({
		page,
	}) => {
		const prefix = newPageName();
		await createPage(page, `${prefix}-a`, "先に書いた");
		await createPage(page, `${prefix}-b`, "あとで書いた");
		const mine = () => cards(page).filter({ hasText: prefix }).getByRole("heading");

		// 一覧に載るのは、書き換えが落ち着いてから。
		await expect(async () => {
			await page.goto("/");
			await expect(mine()).toHaveText([`${prefix}-b`, `${prefix}-a`], { timeout: 1000 });
		}).toPass();

		await page.getByLabel("並び順").selectOption("title");
		await expect(page).toHaveURL(/\?sort=title$/);
		await showAllCards(page);
		await expect(mine()).toHaveText([`${prefix}-a`, `${prefix}-b`]);

		await page.reload();
		await expect(page.getByLabel("並び順")).toHaveValue("title");
		await showAllCards(page);
		await expect(mine()).toHaveText([`${prefix}-a`, `${prefix}-b`]);
	});

	test("名前を入れて、新しいページを書き始められる", async ({ page }) => {
		const name = newPageName();
		await page.goto("/");

		await page.getByLabel("新しいページの名前").fill(`${name} メモ`);
		await page.getByRole("button", { name: "作る" }).click();

		await expect(page).toHaveURL(new RegExp(`/${name}_${encodeURIComponent("メモ")}$`));
		await expect(page.getByTestId("line").first()).toHaveAttribute("data-text", `${name} メモ`);
		await expect(status(page)).toHaveText("新しいページです。書き始めると保存されます");
	});

	test("見出しを押すと、どのページからでもトップへ戻れる", async ({ page }) => {
		await page.goto(`/${newPageName()}`);

		await page.getByRole("link", { name: "Amime" }).click();

		await expect(page.getByRole("region", { name: "ページの一覧" })).toBeVisible();
	});
});
