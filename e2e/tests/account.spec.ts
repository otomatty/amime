import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test.describe("ログイン", () => {
	test("開発用のログインでログインでき、再読み込みしてもログインしたまま。ログアウトできる", async ({
		page,
	}) => {
		const name = `e2e-${randomUUID().slice(0, 8)}`;
		await page.goto("/");
		const header = page.locator(".app-header");

		await page.getByRole("textbox", { name: "開発用ログインの名前" }).fill(name);
		await page.getByRole("button", { name: "開発用ログイン" }).click();

		await expect(header).toContainText(name);
		await page.reload();
		await expect(header).toContainText(name);

		await page.getByRole("button", { name: "ログアウト" }).click();
		await expect(page.getByRole("button", { name: "開発用ログイン" })).toBeVisible();
		await expect(header).not.toContainText(name);
		await page.reload();
		await expect(page.getByRole("button", { name: "開発用ログイン" })).toBeVisible();
	});

	test("Google の設定がない環境では、Google でログインするリンクを出さない", async ({ page }) => {
		await page.goto("/");

		await expect(page.getByRole("button", { name: "開発用ログイン" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Google でログイン" })).toHaveCount(0);
	});
});
