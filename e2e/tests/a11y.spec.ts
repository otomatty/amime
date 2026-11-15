import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * 主な画面を、axe で検査する(WCAG 2.1 の A と AA)。
 * axe が見つけられるのは、機械で分かる違反(名前のないボタン、色の対比、見出しの順など)だけ。
 * スクリーンリーダーでの読み上げ(#3)は、別に確かめる。
 */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** 違反を、どこの何かが分かる短い文にする(失敗したときに読む)。 */
function summarize(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string[] {
	return violations.flatMap((violation) =>
		violation.nodes.map(
			(node) =>
				`${violation.id}(${violation.impact ?? "?"}): ${node.target.join(" ")} — ${violation.help}`,
		),
	);
}

async function expectNoViolations(page: Page) {
	const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
	expect(summarize(result.violations)).toEqual([]);
}

async function freshPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	return context.newPage();
}

/** 本文のあるページを作る。 */
async function createPage(page: Page, name: string, ...body: string[]) {
	await page.goto(`/e2e/${name}`);
	const box = await page.getByTestId("line").first().boundingBox();
	if (!box) throw new Error("the title line is not visible");
	await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
	for (const text of body) {
		await page.keyboard.press("Enter");
		await page.keyboard.type(text);
	}
	await expect(page.getByRole("status")).toHaveText("保存済み");
}

// Playwright の Firefox では、axe を動かすと、ページの処理がときどき落ちる(Page crashed)。
// 落ちる画面と規則は、実行のたびに変わる。WebKit と Chromium では落ちない。
// 原因を調べるまで、Firefox では動かさない(@not-firefox。playwright.config.ts。#37)。axe の検査の結果は、
// ブラウザのエンジンにはほとんどよらないので、Chromium と WebKit(スマートフォンを含む)で確かめる。
test.describe("アクセシビリティ(axe で機械的に分かる違反がない)", { tag: "@not-firefox" }, () => {
	test("ログインしていないときのトップ", async ({ browser }) => {
		const page = await freshPage(browser);
		await page.goto("/");
		await expect(page.getByText(/チームで書くノートです/)).toBeVisible();

		await expectNoViolations(page);
	});

	test("試し書きのページ", async ({ page }) => {
		await page.goto("/?playground");
		await expect(page.getByTestId("line").first()).toBeVisible();

		await expectNoViolations(page);
	});

	test("参加しているプロジェクトの一覧", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("link", { name: "e2e" }).first()).toBeVisible();

		await expectNoViolations(page);
	});

	test("ページの一覧と、記法を含むページ、関連するページ", async ({ page }) => {
		const token = randomUUID().slice(0, 8);
		await createPage(
			page,
			`${token}-a`,
			`[${token}-b] へのリンクと [* 太字] と #タグ`,
			" 字下げした行",
			"`コード`",
		);
		await createPage(page, `${token}-b`, `[${token}-a] へ戻る`);

		// 記法を含むページ(a)を開き、関連するページ(b)のカードが出てから検査する。
		// カードが出るのは、台帳に反映されてから。出るまで開き直す。
		const related = page.getByRole("region", { name: "関連するページ" });
		await expect(async () => {
			await page.goto(`/e2e/${token}-a`);
			await expect(related.getByRole("heading", { name: `${token}-b` })).toBeVisible({
				timeout: 1000,
			});
		}).toPass();
		await expect(page.getByTestId("line").filter({ hasText: "太字" })).toBeVisible();
		await expectNoViolations(page);

		// 一覧に出るのは、台帳に反映されてから。出るまで読み込み直してから検査する。
		await page.goto("/e2e/");
		await expect(async () => {
			await page.reload();
			await expect(page.getByRole("link", { name: new RegExp(`${token}-b`) }).first()).toBeVisible({
				timeout: 1000,
			});
		}).toPass();
		await expectNoViolations(page);
	});

	test("本文から探した結果", async ({ page }) => {
		const token = randomUUID().slice(0, 8);
		await createPage(page, `${token}-hit`, `${token} を探す`);
		await page.goto(`/e2e/?q=${token}`);
		await expect(page.getByRole("heading", { level: 2 })).toContainText(token);
		// 見つかるのは、台帳に反映されてから。結果(リンク、添える行、語の印)が出てから検査する。
		await expect(async () => {
			await page.reload();
			await expect(page.getByRole("link", { name: `${token}-hit` })).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect(page.locator("mark").first()).toBeVisible();

		await expectNoViolations(page);
	});

	test("プロジェクトの設定と、自分のプロフィール", async ({ page }) => {
		await page.goto("/settings/e2e");
		await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
		await expectNoViolations(page);

		await page.goto("/settings");
		await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
		await expectNoViolations(page);
	});
});
