import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const newPageName = () => `e2e-${randomUUID()}`;
const status = (page: Page) => page.getByRole("status");
const related = (page: Page) => page.getByRole("region", { name: "関連するページ" });

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
			await page.goto(`/e2e/${from}`);
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
			await page.goto(`/e2e/${first}`);
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

	test("ページの名前を変えると、そのページへのリンクも、新しい名前に書き換わる(開いたままの画面でも)", async ({
		page,
		context,
	}) => {
		const target = newPageName();
		const from = newPageName();
		await createPage(page, target, "中身");
		await createPage(page, from, `[${target}] を読む`, `#${target}`);
		// リンク元を、別の画面で開いたままにしておく。
		const other = await context.newPage();
		await other.goto(`/e2e/${from}`);
		await expect(other.getByTestId("connection")).toHaveText("オンライン");

		// 1行目を書き換えて、名前を変える。
		await page.goto(`/e2e/${target}`);
		await clickLineEnd(page, 0);
		await page.keyboard.type("-renamed");
		await expect(page).toHaveURL(new RegExp(`/${target}-renamed$`));

		const lines = other.getByTestId("line");
		await expect(lines.nth(1)).toHaveAttribute("data-text", `[${target}-renamed] を読む`);
		await expect(lines.nth(2)).toHaveAttribute("data-text", `#${target}-renamed`);
		// 読み込み直しても、書き換わったまま(保存されている)。リンクをたどると、名前を変えたページが開く。
		await other.reload();
		await other
			.getByRole("link", { name: `${target}-renamed`, exact: true })
			.first()
			.click();
		await expect(other.getByTestId("line").nth(1)).toHaveAttribute("data-text", "中身");
	});

	test("リンクを書いている途中に、既存のページの名前が候補に出る。選ぶと、その名前へのリンクになる", async ({
		page,
	}) => {
		// 他のテストのページと混ざらないように、このテストだけの語を名前に入れる。
		const token = randomUUID().slice(0, 8);
		await createPage(page, `${token}_買い物_メモ`, "牛乳");
		await page.goto(`/e2e/${newPageName()}`);
		await clickLineEnd(page, 0);
		await page.keyboard.press("Enter");
		const options = page.getByRole("option");

		await page.keyboard.type(`[${token} 買`);
		// 候補に出るのは、台帳に反映されてから(書き換えが落ち着いてから)。打ち直して、探し直す。
		await expect(async () => {
			await page.keyboard.press("Backspace");
			await page.keyboard.type("買");
			await expect(options).toHaveText([`${token} 買い物 メモ`], { timeout: 1000 });
		}).toPass();
		await page.keyboard.press("ArrowDown");
		await expect(options.first()).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Enter");

		// 括弧が閉じられ、カーソルはその後ろにある。続けて書ける。
		await page.keyboard.type(" を見る");
		await expect(page.getByTestId("line").nth(1)).toHaveAttribute(
			"data-text",
			`[${token} 買い物 メモ] を見る`,
		);
		await expect(options).toHaveCount(0);
		await expect(status(page)).toHaveText("保存済み");
	});

	test("候補の一覧の余白を押しても、候補は閉じない。編集欄のカーソルは、書いていたところから動かない", async ({
		page,
	}) => {
		const token = randomUUID().slice(0, 8);
		await createPage(page, `${token}_候補`, "中身");
		// 候補の一覧が、下の行に重なるようにする(一覧を押したことが編集欄に伝わると、カーソルが下の行へ移る)。
		await createPage(page, newPageName(), "", "下の行1", "下の行2", "下の行3");
		await clickLineEnd(page, 1);
		const list = page.getByRole("listbox", { name: "ページの名前の候補" });

		await page.keyboard.type(`[${token} 候`);
		await expect(async () => {
			await page.keyboard.press("Backspace");
			await page.keyboard.type("候");
			await expect(list.getByRole("option")).toHaveCount(1, { timeout: 1000 });
		}).toPass();
		const box = await list.boundingBox();
		if (!box) throw new Error("the list is not visible");
		// 枠のすぐ内側(候補のない余白)を押す。
		await page.mouse.click(box.x + 2, box.y + box.height / 2);

		await expect(list).toBeVisible();
		await page.keyboard.type("補");
		await expect(page.getByTestId("line").nth(1)).toHaveAttribute("data-text", `[${token} 候補`);
		await expect(page.getByTestId("line").nth(2)).toHaveAttribute("data-text", "下の行1");
	});
});
