import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";

const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** ログインしていない状態の、新しい画面。 */
async function freshPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	return context.newPage();
}

/** 開発用のログインで、その名前の利用者としてログインする。 */
async function loginAs(page: Page, name: string) {
	await page.goto("/");
	await page.getByRole("textbox", { name: "開発用ログインの名前" }).fill(name);
	await page.getByRole("button", { name: "開発用ログイン" }).click();
	await expect(page.locator(".app-header")).toContainText(name);
}

/** トップから、プロジェクトを作る。作ると、そのプロジェクトのトップへ移る。 */
async function createProject(page: Page, name: string, visibility: "public" | "private") {
	await page.goto("/");
	await page.getByRole("textbox", { name: /名前/ }).fill(name);
	await page.getByRole("combobox", { name: "公開範囲" }).selectOption(visibility);
	await page.getByRole("button", { name: "プロジェクトを作る" }).click();
	await expect(page).toHaveURL(new RegExp(`/${name}/$`));
}

/** プロジェクトのトップから、本文のあるページを作る。 */
async function writePage(page: Page, title: string, body: string) {
	await page.getByRole("textbox", { name: "新しいページの名前" }).fill(title);
	await page.getByRole("button", { name: "作る" }).click();
	const box = await page.getByTestId("line").first().boundingBox();
	if (!box) throw new Error("the title line is not visible");
	await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
	await page.keyboard.press("Enter");
	await page.keyboard.type(body);
	await expect(page.getByRole("status")).toHaveText("保存済み");
}

/** 一覧に、そのページが並ぶまで待つ(保存してから一覧に載るまで、少し間がある)。 */
async function expectListed(page: Page, title: string) {
	await expect(async () => {
		await page.reload();
		await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible({
			timeout: 1000,
		});
	}).toPass();
}

test.describe("プロジェクト", () => {
	test("プロジェクトを作ると、トップの一覧に並び、ページを書ける", async ({ page }) => {
		const name = unique("mine");

		await createProject(page, name, "private");
		await writePage(page, "最初のページ", "本文です");

		await page.goto("/");
		const link = page.getByRole("link", { name, exact: true });
		await expect(link).toBeVisible();
		await link.click();
		await expectListed(page, "最初のページ");
	});

	test("同じ名前のプロジェクトは作れない", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("textbox", { name: /名前/ }).fill("e2e");
		await page.getByRole("button", { name: "プロジェクトを作る" }).click();

		await expect(page.getByRole("alert")).toContainText("すでにあります");
		await expect(page).toHaveURL(/\/$/);
	});

	test("非公開のプロジェクトは、メンバーでない人にも、ログインしていない人にも見えない", async ({
		page,
		browser,
	}) => {
		const name = unique("private");
		await createProject(page, name, "private");
		await writePage(page, "秘密のページ", "秘密の本文");
		const pagePath = `/${name}/${encodeURIComponent("秘密のページ")}`;

		const anonymous = await freshPage(browser);
		await anonymous.goto(pagePath);
		await expect(anonymous.getByText(/ないか、見る権限がありません/)).toBeVisible();
		await expect(anonymous.getByText("秘密の本文")).toHaveCount(0);
		expect((await anonymous.request.get(`/api/projects/${name}/pages`)).status()).toBe(404);

		await loginAs(anonymous, unique("stranger"));
		await anonymous.goto(`/${name}/`);
		await expect(anonymous.getByText(/ないか、見る権限がありません/)).toBeVisible();
		// トップの一覧にも、出てこない。
		await anonymous.goto("/");
		await expect(anonymous.getByText(/参加しているプロジェクトは、まだありません/)).toBeVisible();
		await anonymous.context().close();
	});

	test("公開のプロジェクトは、メンバーでない人も読める。書くことはできない", async ({
		page,
		browser,
	}) => {
		const name = unique("public");
		await createProject(page, name, "public");
		await writePage(page, "公開のページ", "誰でも読める本文");

		const viewer = await freshPage(browser);
		await viewer.goto(`/${name}/`);
		// 一覧は見えるが、新しいページを作る欄はない。
		await expectListed(viewer, "公開のページ");
		await expect(viewer.getByRole("textbox", { name: "新しいページの名前" })).toHaveCount(0);

		await viewer.getByRole("link", { name: /公開のページ/ }).click();
		await expect(viewer.getByText("誰でも読める本文")).toBeVisible();
		await expect(viewer.getByRole("status")).toContainText("読むだけの表示です");
		await expect(viewer.getByRole("textbox", { name: "ページの本文" })).toHaveCount(0);
		// APIでも、書き込めない。
		const commit = await viewer.request.post(`/api/projects/${name}/pages/x/commits`, {
			data: { id: unique("c"), changes: [] },
		});
		expect(commit.status()).toBe(403);

		// メンバーが書き足すと、読むだけの人の画面にも、その場で届く。
		const box = await page.getByTestId("line").nth(1).boundingBox();
		if (!box) throw new Error("the body line is not visible");
		await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
		await page.keyboard.type("(追記)");
		await expect(viewer.getByText("誰でも読める本文(追記)")).toBeVisible();
		await viewer.context().close();
	});
});
