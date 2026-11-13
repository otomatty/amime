import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const status = (page: Page) => page.getByRole("status");
const search = (page: Page) => page.getByRole("combobox", { name: "ページを探す" });

/** 指定した行の末尾の余白を押して、カーソルを行末に置く。 */
async function clickLineEnd(page: Page, index: number) {
	const box = await page.getByTestId("line").nth(index).boundingBox();
	if (!box) throw new Error(`line ${index} is not visible`);
	// 長い行は、折り返して何段かになる。行末は最後の段にあるので、下の端の近くを押す。
	await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
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
		const options = page.locator('[role="option"][data-kind="title"]');

		// 候補に出るのは、台帳に反映されてから(書き換えが落ち着いてから)。
		await expect(async () => {
			await search(page).fill("");
			await search(page).fill(token);
			// 名前の先頭に合うものが、先に並ぶ(文字が飛び飛びに合うだけの、他のページの名前より前)。
			await expect(options.nth(0)).toHaveText(`${token} 旅行`, { timeout: 1000 });
			await expect(options.nth(1)).toHaveText(`${token} 買い物 メモ`, { timeout: 1000 });
		}).toPass();

		// 語を足すと、絞り込まれる。文字が飛び飛びでも合う。
		await search(page).fill(`${token} 買物`);
		await expect(options.first()).toHaveText(`${token} 買い物 メモ`);
		await expect(options.filter({ hasText: `${token} 旅行` })).toHaveCount(0);

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
		const options = page.locator('[role="option"][data-kind="title"]');
		await expect(async () => {
			await search(page).fill("");
			await search(page).fill(token);
			await expect(options.nth(1)).toHaveText(`${token}-a`, { timeout: 1000 });
		}).toPass();
		await expect(options.nth(0)).toHaveText(`${token}-b`);

		await search(page).press("ArrowDown");
		await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
		const chosen = await options.nth(1).textContent();
		await search(page).press("Enter");
		await expect(page).toHaveURL(new RegExp(`/${chosen}$`));

		await search(page).fill(`${token} どこにもない名前`);
		await expect(page.getByText("合う名前のページはありません")).toBeVisible();
	});
});

test.describe("本文からページを探す", () => {
	test("本文の言葉から、ページを探せる。語を含む行が見え、結果からそのページを開ける", async ({
		page,
	}) => {
		// 他のテストのページと混ざらないように、このテストだけの語を本文に入れる。
		const token = randomUUID().slice(0, 8);
		await createPage(page, `${token}-a`, `${token} の牛乳を [* 2本] 買う`, "関係ない行");
		await createPage(page, `${token}-b`, "京都へ行く");

		// 名前には「牛乳」がないので、名前の候補は出ない。「本文から探す」を選ぶ。
		await search(page).fill(`${token} 牛乳`);
		await page.getByRole("option", { name: `「${token} 牛乳」を本文から探す` }).click();

		await expect(page).toHaveURL(new RegExp(`/\\?q=${token}`));
		await expect(page.getByRole("heading", { level: 2 })).toHaveText(
			`「${token} 牛乳」を本文から探した結果`,
		);
		// 見つかるのは、台帳に反映されてから(書き換えが落ち着いてから)。
		const hits = page.getByRole("listitem");
		await expect(async () => {
			await page.reload();
			await expect(hits).toHaveCount(1, { timeout: 1000 });
		}).toPass();
		await expect(hits.getByRole("link")).toHaveText(`${token}-a`);
		// 語を含む行が、記法の記号を除いて添えられる。語には印が付く。
		await expect(hits.getByText("の牛乳を 2本 買う")).toBeVisible();
		await expect(hits.locator("mark")).toHaveText([token, token, "牛乳"]);
		// 探した語は、欄に残っている。
		await expect(search(page)).toHaveValue(`${token} 牛乳`);

		await hits.getByRole("link").click();

		await expect(page).toHaveURL(new RegExp(`/${token}-a$`));
		await expect(page.getByTestId("line").nth(2)).toHaveAttribute("data-text", "関係ない行");
	});

	test("見つからなければ、そのことが分かる。Enter だけでも、本文から探せる", async ({ page }) => {
		const words = `どこにもない言葉 ${randomUUID()}`;
		await page.goto("/");

		await search(page).fill(words);
		// 合う名前がないので、「本文から探す」が選ばれている。
		const candidates = page.getByRole("listbox", { name: "ページの候補" });
		await expect(candidates.getByRole("option", { selected: true })).toHaveText(
			`「${words}」を本文から探す`,
		);
		await search(page).press("Enter");

		await expect(page.getByText(`「${words}」を含むページはありません。`)).toBeVisible();
	});
});
