import { expect, test } from "@playwright/test";

test.describe("起動確認", () => {
	test("トップページにプロダクト名と行が表示される", async ({ page }) => {
		await page.goto("/");

		await expect(page.getByRole("heading", { level: 1, name: "Amime" })).toBeVisible();
		await expect(page.getByTestId("line").first()).toBeVisible();
	});

	test("インデントされた行は字下げされ、行頭の空白は文字として表示されない", async ({ page }) => {
		await page.goto("/");

		const flat = page.getByTestId("line").filter({ hasText: "はじめに" });
		const nested = page.getByTestId("line").filter({ hasText: "2段目" });

		await expect(nested).toHaveText("2段目");
		const flatLeft = await flat.locator("span").last().boundingBox();
		const nestedLeft = await nested.locator("span").last().boundingBox();
		expect(nestedLeft?.x).toBeGreaterThan(flatLeft?.x ?? Number.POSITIVE_INFINITY);
	});

	test("SPAなので、未知のパスでもアプリが表示される", async ({ page }) => {
		await page.goto("/some-project/some-page");

		await expect(page.getByRole("heading", { level: 1, name: "Amime" })).toBeVisible();
	});

	test("APIはWorkerが応答する", async ({ request }) => {
		const response = await request.get("/api/health");

		expect(response.status()).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});
