import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

/** スマートフォンの幅。 */
const PHONE = { width: 390, height: 800 };
/** パソコンの幅。 */
const DESKTOP = { width: 1280, height: 800 };

/** 幅の広い中身(長いコード、列の多い表、切れ目のない長い語)のあるページを作り、その名前を返す。 */
async function createWidePage(page: Page): Promise<string> {
	const title = `layout-${randomUUID().slice(0, 8)}`;
	const opened = await page.request.get(`/api/projects/e2e/pages/by-title/${title}`);
	const { id } = (await opened.json()) as { id: string };
	const texts = [
		title,
		"code:long.ts",
		` const text = "${"とても長いコードの行".repeat(12)}";`,
		"table:列の多い表",
		` ${Array.from({ length: 14 }, (_, column) => `列${column + 1}の中身`).join("\t")}`,
		`https://example.com/${"long-path-".repeat(20)}`,
	];
	let after: string | null = null;
	const changes = texts.map((text, index) => {
		const line = { id: `w${index}`, text };
		const change = { type: "insert", line, after, before: null };
		after = line.id;
		return change;
	});
	const saved = await page.request.post(`/api/projects/e2e/pages/${id}/commits`, {
		data: { id: `seed-${randomUUID().slice(0, 8)}`, changes },
	});
	expect(saved.status()).toBe(200);
	return title;
}

/** 画面が、横にはみ出していないこと(横にスクロールしなくても、全部見える)。 */
async function expectNoSidewaysScroll(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
}

const height = async (page: Page, role: "button" | "combobox" | "textbox", name: string) =>
	(await page.getByRole(role, { name }).first().boundingBox())?.height ?? 0;

test.describe("画面の配置(ADR-0036)", () => {
	test("スマートフォンの幅でも、どの画面も、横にはみ出さない", async ({ page }) => {
		const title = await createWidePage(page);
		await page.setViewportSize(PHONE);

		await page.goto("/");
		await expect(page.getByRole("heading", { name: "プロジェクト", exact: true })).toBeVisible();
		await expectNoSidewaysScroll(page);

		await page.goto("/e2e/");
		await expect(page.getByRole("region", { name: "ページの一覧" })).toBeVisible();
		await expectNoSidewaysScroll(page);

		await page.goto(`/e2e/${title}`);
		await expect(page.getByTestId("line").nth(5)).toBeVisible();
		await expectNoSidewaysScroll(page);

		await page.goto("/settings/e2e");
		await expect(page.getByRole("heading", { name: "メンバー" })).toBeVisible();
		await expectNoSidewaysScroll(page);

		await page.goto("/settings");
		await expect(page.getByRole("textbox", { name: /表示名/ })).toBeVisible();
		await expectNoSidewaysScroll(page);
	});

	test("パソコンの幅では、ヘッダーが1段に収まる(名前、探す欄、ログインの状態)", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		await page.goto("/e2e/");
		await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();

		const header = await page.locator(".app-header").boundingBox();

		expect(header?.height).toBeLessThan(72);
	});

	test("ログインの状態が出る前と後で、ヘッダーの高さが変わらない(下の中身が、動かない)", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		// ログインの状態の応答を、止めておく。
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/me", async (route) => {
			await held;
			await route.continue();
		});
		await page.goto("/?playground");
		await expect(page.getByTestId("line").first()).toBeVisible();
		const before = await page.locator(".app-header").boundingBox();

		release();
		await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();

		const after = await page.locator(".app-header").boundingBox();
		expect(after?.height).toBe(before?.height);
	});

	test("ボタンと入力欄は、押しやすい高さにする(パソコンで36px以上、スマートフォンの幅で44px以上)", async ({
		page,
	}) => {
		await page.setViewportSize(DESKTOP);
		await page.goto("/e2e/");
		await expect(page.getByRole("button", { name: "作る" })).toBeVisible();
		for (const [role, name] of [
			["button", "作る"],
			["button", "ログアウト"],
			["textbox", "新しいページの名前"],
			["combobox", "ページを探す"],
			["combobox", "並び順"],
		] as const) {
			expect(await height(page, role, name), name).toBeGreaterThanOrEqual(36);
		}

		await page.setViewportSize(PHONE);
		for (const [role, name] of [
			["button", "作る"],
			["button", "ログアウト"],
			["textbox", "新しいページの名前"],
			["combobox", "ページを探す"],
			["combobox", "並び順"],
		] as const) {
			expect(await height(page, role, name), name).toBeGreaterThanOrEqual(44);
		}
	});

	test("ページでは、保存の状態と、ページの操作が、本文の上の1段に並ぶ", async ({ page }) => {
		const title = await createWidePage(page);
		await page.setViewportSize(DESKTOP);
		await page.goto(`/e2e/${title}`);
		await expect(page.getByRole("status")).toHaveText("保存済み");

		const status = await page.getByRole("status").boundingBox();
		const remove = await page.getByRole("button", { name: "このページを削除" }).boundingBox();
		if (!status || !remove) throw new Error("the page bar is not visible");

		// 縦の位置が重なっている(同じ段にある)。状態が左、操作が右。
		expect(status.y).toBeLessThan(remove.y + remove.height);
		expect(remove.y).toBeLessThan(status.y + status.height);
		expect(status.x).toBeLessThan(remove.x);
	});
});
