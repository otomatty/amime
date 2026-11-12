import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

const lines = (page: Page) => page.getByTestId("line");
const lineTexts = (page: Page) =>
	lines(page).evaluateAll((elements) => elements.map((el) => el.getAttribute("data-text")));
const status = (page: Page) => page.getByRole("status");
/** 行の本文が、期待したとおりになるまで待つ(読み込みや取り込みが終わるのを待つ)。 */
const expectLines = (page: Page, expected: readonly string[]) =>
	expect.poll(() => lineTexts(page)).toEqual(expected);

/** テストごとに別のページを使う(保存した内容が、他のテストや前回の実行と混ざらないように)。 */
const newPageName = () => `e2e-${randomUUID()}`;

/**
 * 操作を行い、その保存が終わるまで待つ。
 * 既に「保存済み」と表示されているときは、表示だけを見ても保存の完了を判断できないので、サーバーの応答を待つ。
 */
async function andWaitForSave(page: Page, action: () => Promise<void>) {
	const committed = page.waitForResponse(
		(response) => response.url().endsWith("/commits") && response.ok(),
	);
	await action();
	await committed;
	await expect(status(page)).toHaveText("保存済み");
}

/** 指定した行の末尾の余白を押して、カーソルを行末に置く。 */
async function clickLineEnd(page: Page, index: number) {
	const box = await lines(page).nth(index).boundingBox();
	if (!box) throw new Error(`line ${index} is not visible`);
	await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
}

test.describe("ページの保存", () => {
	test("まだないページを開くと、URLの名前がタイトルになる。書いた内容は、再読み込みしても残っている", async ({
		page,
	}) => {
		const name = newPageName();
		await page.goto(`/${name}`);
		await expect(lines(page)).toHaveText([name]);
		await expect(status(page)).toHaveText("新しいページです。書き始めると保存されます");

		await clickLineEnd(page, 0);
		await page.keyboard.press("Enter");
		await page.keyboard.type(" [リンク] のある行");
		await expect(status(page)).toHaveText("保存済み");

		await page.reload();

		await expectLines(page, [name, " [リンク] のある行"]);
		await expect(status(page)).toHaveText("保存済み");
	});

	test("日本語と空白を含む名前のページも保存できる", async ({ page }) => {
		const name = `E2E メモ ${randomUUID()}`;
		await page.goto(`/${encodeURIComponent(name.replaceAll(" ", "_"))}`);
		await expect(lines(page).first()).toHaveAttribute("data-text", name);

		await clickLineEnd(page, 0);
		await page.keyboard.type("!");
		await expect(status(page)).toHaveText("保存済み");
		await page.reload();

		await expect(lines(page).first()).toHaveAttribute("data-text", `${name}!`);
	});

	test("行を動かしたり消したりした結果も、そのまま保存される", async ({ page }) => {
		await page.goto(`/${newPageName()}`);
		await clickLineEnd(page, 0);
		for (const text of ["A", " a1", "B"]) {
			await page.keyboard.press("Enter");
			await page.keyboard.press("Shift+Home");
			await page.keyboard.type(text);
		}
		await expect(status(page)).toHaveText("保存済み");

		// B を、A とその子の行の上へ動かす。
		await andWaitForSave(page, () => page.keyboard.press("Alt+ArrowUp"));
		await page.reload();

		await expect(lines(page)).toHaveCount(4);
		expect((await lineTexts(page)).slice(1)).toEqual(["B", "A", " a1"]);
	});

	test("別のタブで書かれた内容は、自分が保存するときに取り込まれ、どちらの変更も残る", async ({
		page,
		context,
	}) => {
		const name = newPageName();
		await page.goto(`/${name}`);
		await clickLineEnd(page, 0);
		await page.keyboard.press("Enter");
		await page.keyboard.type("最初の行");
		await expect(status(page)).toHaveText("保存済み");

		const other = await context.newPage();
		await other.goto(`/${name}`);
		await expect(lines(other)).toHaveCount(2);
		await clickLineEnd(other, 1);
		await other.keyboard.press("Enter");
		await other.keyboard.type("別のタブの行");
		await expect(status(other)).toHaveText("保存済み");

		// 最初のタブは、別のタブの行をまだ知らない。そのまま書いて保存する。
		await page.bringToFront();
		await clickLineEnd(page, 0);
		await page.keyboard.type("!");

		await expectLines(page, [`${name}!`, "最初の行", "別のタブの行"]);
		await expect(status(page)).toHaveText("保存済み");
		await other.reload();
		await expectLines(other, [`${name}!`, "最初の行", "別のタブの行"]);
	});

	test("保存に失敗しても書き続けられ、通信が戻ると自動で保存される", async ({ page }) => {
		const name = newPageName();
		await page.goto(`/${name}`);
		await page.route("**/commits", (route) => route.abort());

		await clickLineEnd(page, 0);
		await page.keyboard.type("!");
		await expect(status(page)).toHaveText("保存できませんでした。自動で再試行します");
		await page.keyboard.type("?");

		await page.unroute("**/commits");
		await expect(status(page)).toHaveText("保存済み", { timeout: 10_000 });
		await page.reload();

		await expect(lines(page).first()).toHaveAttribute("data-text", `${name}!?`);
	});

	test("トップの試し書きは保存されない", async ({ page }) => {
		await page.goto("/");
		await clickLineEnd(page, 0);
		await page.keyboard.type("abc");
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめにabc");

		await page.reload();

		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");
	});
});
