import { expect, test } from "@playwright/test";

test.describe("起動確認", () => {
	test("トップページにプロダクト名と行が表示される", async ({ page }) => {
		await page.goto("/?playground");

		await expect(page.getByRole("heading", { level: 1, name: "Amime" })).toBeVisible();
		await expect(page.getByTestId("line").first()).toBeVisible();
	});

	test("インデントされた行は字下げされ、行頭の空白は文字として表示されない", async ({ page }) => {
		await page.goto("/?playground");

		const flat = page.getByTestId("line").filter({ hasText: "はじめに" });
		const nested = page.getByTestId("line").filter({ hasText: "2段目" });

		await expect(nested).toHaveText("2段目");
		const flatBox = await flat.locator(".char").first().boundingBox();
		const nestedBox = await nested.locator(".char").first().boundingBox();
		expect(nestedBox?.x).toBeGreaterThan(flatBox?.x ?? Number.POSITIVE_INFINITY);
	});

	test("SPAなので、未知のパスでもアプリが表示される", async ({ page }) => {
		await page.goto("/some-project/some-page");

		await expect(page.getByRole("heading", { level: 1 })).toContainText("Amime");
		// ないプロジェクトなので、そのことが表示される。
		await expect(page.getByText(/ないか、見る権限がありません/)).toBeVisible();
	});

	test("E2E用のビルドでは、開発用のログインが使え、メンバーとしてページを読める", async ({
		request,
	}) => {
		const response = await request.get("/api/projects/e2e/pages/e2e-smoke");

		expect(response.status()).toBe(200);
		expect(await response.json()).toEqual({ version: 0, lines: [] });
	});

	test("APIはWorkerが応答する", async ({ request }) => {
		const response = await request.get("/api/health");

		expect(response.status()).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});
