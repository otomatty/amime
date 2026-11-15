import { expect, test } from "@playwright/test";

/**
 * 本番へ出したあとに、画面が開くかを確かめる(ADR-0041)。Deploy のワークフローが、本番のURLに対して動かす。
 * 本番のデータを書き換えないように、ログインせず、読むだけにする。
 */
test.describe("本番の画面が開く", () => {
	test("トップに、名前と、ログインの案内が出る", async ({ page }) => {
		await page.goto("/");

		await expect(page).toHaveTitle("Tsuzuri");
		await expect(page.getByRole("heading", { level: 1, name: "Tsuzuri" })).toBeVisible();
		await expect(page.getByText(/チームで書くノートです/)).toBeVisible();
	});

	test("試し書きのページで、書ける", async ({ page }) => {
		await page.goto("/?playground");
		const line = page.getByTestId("line").first();
		await expect(line).toBeVisible();

		const box = await line.boundingBox();
		if (!box) throw new Error("the first line is not visible");
		await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
		await page.keyboard.press("Enter");
		await page.keyboard.type("本番の確認");
		await expect(page.getByTestId("line").filter({ hasText: "本番の確認" })).toBeVisible();
	});

	test("ログインしていないと、APIは中身を返さない", async ({ request }) => {
		const me = await request.get("/api/me");
		expect(me.ok()).toBe(true);
		expect(await me.json()).toMatchObject({ user: null });

		// 開発用のログインは、本番では使えない(ADR-0032)。
		const dev = await request.post("/api/auth/dev", { data: { name: "production-check" } });
		expect(dev.ok()).toBe(false);
	});
});
