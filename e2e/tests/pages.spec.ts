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
	// 長い行は、折り返して何段かになる。行末は最後の段にあるので、下の端の近くを押す。
	await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
}

/** 本文のあるページを作る。 */
async function createPage(page: Page, name: string, ...body: string[]) {
	await page.goto(`/e2e/${name}`);
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
	// 一覧を読み込み終えるのを待つ。ページが1つもないときは、カードの代わりに案内が出る。
	// (案内の文と同じ名前のページがあっても迷わないように、案内は要素で指し、どちらか先に見つかったほうを待つ)
	await cards(page).first().or(page.locator("p.page-message")).first().waitFor();
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
			await page.goto("/e2e/");
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
			await page.goto("/e2e/");
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
		await page.goto("/e2e/");

		await page.getByLabel("新しいページの名前").fill(`${name} メモ`);
		await page.getByRole("button", { name: "作る" }).click();

		await expect(page).toHaveURL(new RegExp(`/${name}_${encodeURIComponent("メモ")}$`));
		await expect(page.getByTestId("line").first()).toHaveAttribute("data-text", `${name} メモ`);
		await expect(status(page)).toHaveText("新しいページです。書き始めると保存されます");
	});

	test("ページを固定すると、並び順にかかわらず一覧の先頭に並ぶ。外すと、元の位置に戻る", async ({
		page,
	}) => {
		const prefix = newPageName();
		await createPage(page, `${prefix}-a`, "先に書いた");
		await createPage(page, `${prefix}-b`, "あとで書いた");
		const mine = () => cards(page).filter({ hasText: prefix }).getByRole("heading");

		await page.goto(`/e2e/${prefix}-a`);
		await page.getByRole("button", { name: "一覧の先頭に固定する" }).click();
		await expect(page.getByRole("button", { name: "固定を外す" })).toBeVisible();

		// 更新が新しいのは b だが、固定した a が先に並ぶ。
		await expect(async () => {
			await page.goto("/e2e/");
			await showAllCards(page);
			await expect(mine()).toHaveText([`${prefix}-a`, `${prefix}-b`], { timeout: 1000 });
		}).toPass();
		await expect(cardOf(page, `${prefix}-a`).getByText("固定", { exact: true })).toBeVisible();

		await page.goto(`/e2e/${prefix}-a`);
		await page.getByRole("button", { name: "固定を外す" }).click();
		await expect(page.getByRole("button", { name: "一覧の先頭に固定する" })).toBeVisible();
		await page.goto("/e2e/");
		await showAllCards(page);
		await expect(mine()).toHaveText([`${prefix}-b`, `${prefix}-a`]);
	});

	test("ページを削除すると、確かめたうえで消え、一覧からなくなる。開いていた他の画面にも伝わり、同じ名前で作り直せる", async ({
		page,
		context,
	}) => {
		const name = newPageName();
		await createPage(page, name, "消す本文");
		await expect(async () => {
			await page.goto("/e2e/");
			await showAllCards(page);
			await expect(cardOf(page, name)).toBeVisible({ timeout: 1000 });
		}).toPass();
		await page.goto(`/e2e/${name}`);
		await expect(status(page)).toHaveText("保存済み");
		const other = await context.newPage();
		await other.goto(`/e2e/${name}`);
		await expect(other.getByTestId("connection")).toHaveText("オンライン");

		await page.getByRole("button", { name: "このページを削除" }).click();
		await expect(page.getByText("削除すると、元には戻せません")).toBeVisible();
		await page.getByRole("button", { name: "削除する" }).click();

		// 削除した画面は、一覧へ戻る。消したページは、もう並ばない。
		await expect(page.getByRole("region", { name: "ページの一覧" })).toBeVisible();
		await showAllCards(page);
		await expect(cardOf(page, name)).toHaveCount(0);
		// 開いていた他の画面には、削除されたことが伝わる。書いてあった内容は、画面に残る。
		await expect(status(other)).toHaveText(
			"このページは削除されました。ここに書いても、保存されません",
		);
		await expect(other.getByTestId("line").nth(1)).toHaveAttribute("data-text", "消す本文");
		// 同じ名前を開くと、前の本文を引き継がない、新しいページになる。
		await page.goto(`/e2e/${name}`);
		await expect(status(page)).toHaveText("新しいページです。書き始めると保存されます");
		await expect(page.getByTestId("line")).toHaveCount(1);
	});

	test("見出しのプロジェクトの名前を押すと、どのページからでも、ページの一覧へ戻れる", async ({
		page,
	}) => {
		await page.goto(`/e2e/${newPageName()}`);

		await page.getByRole("link", { name: "e2e", exact: true }).click();

		await expect(page.getByRole("region", { name: "ページの一覧" })).toBeVisible();
	});

	test("見出しの Amime を押すと、参加しているプロジェクトの一覧へ戻れる", async ({ page }) => {
		await page.goto(`/e2e/${newPageName()}`);

		await page.getByRole("link", { name: "Amime" }).click();

		await expect(page.getByRole("heading", { name: "プロジェクト", exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "e2e", exact: true })).toBeVisible();
	});
});
