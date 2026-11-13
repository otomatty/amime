import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";

const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
/** 1ピクセルの PNG。アイコンの画像の代わりにする。 */
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

/** 開発用のログインでログインした、新しい画面。画像の置き場所への要求には、決まった画像を返す。 */
async function loggedIn(browser: Browser, name: string): Promise<Page> {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	await context.route("https://images.example/**", (route) =>
		route.fulfill({ contentType: "image/png", body: PIXEL }),
	);
	const page = await context.newPage();
	await page.goto("/");
	await page.getByRole("textbox", { name: "開発用ログインの名前" }).fill(name);
	await page.getByRole("button", { name: "開発用ログイン" }).click();
	await expect(page.locator(".app-header")).toContainText(name);
	return page;
}

/** 行の末尾の余白を押して、カーソルを行末に置く。 */
async function clickLineEnd(page: Page, index: number) {
	const box = await page.getByTestId("line").nth(index).boundingBox();
	if (!box) throw new Error(`line ${index} is not visible`);
	await page.mouse.click(box.x + box.width - 2, box.y + box.height - 4);
}

test.describe("プロフィール", () => {
	test("表示名とアイコンを設定でき、[名前.icon] で本文に置ける。他の人には、カーソルに名前が添えられて見える", async ({
		browser,
	}) => {
		const displayName = `花子${randomUUID().slice(0, 6)}`;
		const hanako = await loggedIn(browser, unique("hanako"));

		// 表示名とアイコンを設定する。
		await hanako
			.locator(".app-header")
			.getByRole("link", { name: /^hanako-/ })
			.click();
		await expect(hanako.getByRole("heading", { name: "プロフィール" })).toBeVisible();
		await hanako.getByRole("textbox", { name: /表示名/ }).fill(displayName);
		await hanako
			.getByRole("textbox", { name: /アイコンの画像のURL/ })
			.fill("https://images.example/hanako.png");
		await hanako.getByRole("button", { name: "保存する" }).click();
		await expect(hanako.getByRole("status")).toHaveText("保存しました");
		await expect(hanako.locator(".app-header")).toContainText(displayName);

		// プロジェクトを作って、ページに自分のアイコンを置く。
		const project = unique("profile");
		await hanako.goto("/");
		await hanako.getByRole("textbox", { name: /名前/ }).fill(project);
		await hanako.getByRole("button", { name: "プロジェクトを作る" }).click();
		await hanako.getByRole("textbox", { name: "新しいページの名前" }).fill("自己紹介");
		await hanako.getByRole("button", { name: "作る" }).click();
		await clickLineEnd(hanako, 0);
		await hanako.keyboard.press("Enter");
		await hanako.keyboard.type(`[${displayName}.icon] です`);
		await hanako.keyboard.press("Enter");
		await hanako.keyboard.type("2行目");
		await expect(hanako.getByRole("status")).toHaveText("保存済み");
		// カーソルのない行では、アイコンの画像になる。
		const icon = hanako.getByRole("img", { name: displayName });
		await expect(icon).toBeVisible();
		await expect(icon).toHaveAttribute("src", "https://images.example/hanako.png");

		// 招待された人が同じページを開くと、花子のカーソルに、表示名が添えられている。
		await hanako.goto(`/settings/${project}`);
		await hanako.getByRole("button", { name: "招待リンクを作る" }).click();
		const link = await hanako.getByRole("textbox", { name: /新しい招待リンク/ }).inputValue();
		const taro = await loggedIn(browser, unique("taro"));
		await taro.goto(new URL(link).pathname);
		await taro.getByRole("button", { name: "参加する" }).click();
		// 参加すると、プロジェクトのトップへ移る。移り終わってから、ページを開く。
		await expect(taro).toHaveURL(new RegExp(`/${project}/$`));
		await taro.goto(`/${project}/${encodeURIComponent("自己紹介")}`);
		await expect(taro.getByRole("img", { name: displayName })).toBeVisible();

		await hanako.goto(`/${project}/${encodeURIComponent("自己紹介")}`);
		await clickLineEnd(hanako, 2);
		await expect(taro.locator(".remote-caret-name")).toHaveText(displayName);

		await hanako.context().close();
		await taro.context().close();
	});

	test("ログインしていなければ、プロフィールは変えられない", async ({ browser }) => {
		const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();

		await page.goto("/settings");

		await expect(page.getByText("プロフィールを変えるには、ログインしてください。")).toBeVisible();
		expect((await page.request.patch("/api/me", { data: { name: "x" } })).status()).toBe(401);
		await context.close();
	});
});
