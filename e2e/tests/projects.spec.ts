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
	test("招待リンクを作って送ると、受け取った人がメンバーとして参加でき、書ける。外すと、見られなくなる", async ({
		page,
		browser,
	}) => {
		const name = unique("invite");
		await createProject(page, name, "private");
		await writePage(page, "会議のメモ", "管理者が書いた本文");

		// 管理者が、設定で、招待リンクを作る。
		await page.goto(`/${name}/`);
		await page.getByRole("link", { name: "メンバーと設定" }).click();
		await page.getByRole("button", { name: "招待リンクを作る" }).click();
		const link = await page.getByRole("textbox", { name: /新しい招待リンク/ }).inputValue();
		expect(link).toMatch(/\/invite\/[\w-]{43}$/);

		// 受け取った人が、リンクを開く。ログインしていないので、まだ参加できない。
		const guest = await freshPage(browser);
		const guestName = unique("guest");
		await guest.goto(new URL(link).pathname);
		await expect(guest.getByRole("heading", { name: `「${name}」への招待` })).toBeVisible();
		await expect(guest.getByText("参加するには、ログインしてください")).toBeVisible();
		// ログインすると、参加できる。
		await guest.getByRole("textbox", { name: "開発用ログインの名前" }).fill(guestName);
		await guest.getByRole("button", { name: "開発用ログイン" }).click();
		await guest.getByRole("button", { name: "参加する" }).click();
		await expect(guest).toHaveURL(new RegExp(`/${name}/$`));

		// メンバーとして、ページを読み書きできる。
		await expectListed(guest, "会議のメモ");
		await guest.getByRole("link", { name: /会議のメモ/ }).click();
		await expect(guest.getByText("管理者が書いた本文")).toBeVisible();
		const box = await guest.getByTestId("line").nth(1).boundingBox();
		if (!box) throw new Error("the body line is not visible");
		await guest.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
		await guest.keyboard.type("(参加した人の追記)");
		await expect(guest.getByRole("status")).toHaveText("保存済み");

		// 管理者の設定に、参加した人が並ぶ。外すと、その人は見られなくなる。
		await page.reload();
		await page.getByRole("button", { name: `${guestName} を外す` }).click();
		await expect(page.getByRole("list", { name: "メンバー" }).getByRole("listitem")).toHaveCount(1);
		await guest.goto(`/${name}/`);
		await expect(guest.getByText(/ないか、見る権限がありません/)).toBeVisible();
		await guest.context().close();
	});

	test("無効にした招待リンクでは、参加できない", async ({ page, browser }) => {
		const name = unique("revoked");
		await createProject(page, name, "private");
		await page.goto(`/settings/${name}`);
		await page.getByRole("button", { name: "招待リンクを作る" }).click();
		const link = await page.getByRole("textbox", { name: /新しい招待リンク/ }).inputValue();

		await page.getByRole("button", { name: "無効にする" }).click();
		await expect(page.getByRole("list", { name: "使える招待リンク" })).toHaveCount(0);

		const guest = await freshPage(browser);
		await guest.goto(new URL(link).pathname);
		await expect(guest.getByText(/この招待リンクは、使えません/)).toBeVisible();
		await guest.context().close();
	});

	test("公開範囲を、あとから変えられる", async ({ page, browser }) => {
		const name = unique("switch");
		await createProject(page, name, "private");
		const viewer = await freshPage(browser);
		await viewer.goto(`/${name}/`);
		await expect(viewer.getByText(/ないか、見る権限がありません/)).toBeVisible();

		await page.goto(`/settings/${name}`);
		await page.getByRole("combobox", { name: "公開範囲" }).selectOption("public");
		await expect(page.getByRole("combobox", { name: "公開範囲" })).toHaveValue("public");

		await expect(async () => {
			await viewer.reload();
			await expect(viewer.getByRole("region", { name: "ページの一覧" })).toBeVisible({
				timeout: 1000,
			});
		}).toPass();
		await viewer.context().close();
	});
});
