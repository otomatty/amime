// 一時的な調査用(Firefox で axe を動かすと落ちる原因を探す)。調べ終わったら消す。
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const require = createRequire(require_resolve());
function require_resolve() {
	return createRequire(import.meta.url).resolve("@axe-core/playwright");
}

test("調査: 検索結果の画面で、axe のどの規則で落ちるか", async ({ page, context, browserName }) => {
	test.setTimeout(600_000);
	const token = randomUUID().slice(0, 8);
	await page.goto(`/e2e/${token}-hit`);
	const box = await page.getByTestId("line").first().boundingBox();
	if (!box) throw new Error("no line");
	await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
	await page.keyboard.press("Enter");
	await page.keyboard.type(`${token} を探す`);
	await expect(page.getByRole("status")).toHaveText("保存済み");
	const url = `/e2e/?q=${token}`;
	await page.goto(url);
	await expect(async () => {
		await page.reload();
		await expect(page.getByRole("link", { name: `${token}-hit` })).toBeVisible({ timeout: 1000 });
	}).toPass();
	await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
	const rules: string[] = await page.evaluate(() =>
		// @ts-expect-error 調査用
		window.axe.getRules(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).map((r) => r.ruleId),
	);
	const report: string[] = [`${browserName}: ${rules.length} rules`];
	for (const rule of rules) {
		const tab = await context.newPage();
		await tab.goto(url);
		await expect(tab.getByRole("link", { name: `${token}-hit` })).toBeVisible();
		try {
			await new AxeBuilder({ page: tab }).withRules([rule]).analyze();
		} catch (error) {
			report.push(`${rule}: ${String(error).slice(0, 80)}`);
		}
		await tab.close().catch(() => {});
	}
	expect(report).toEqual([`${browserName}: ${rules.length} rules`]);
});
