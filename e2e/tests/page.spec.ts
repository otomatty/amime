import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

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

test.describe("同時編集", () => {
	/** 1行の本文があるページを作り、もう1つのタブでも開く。 */
	async function openInTwoTabs(page: Page, context: BrowserContext) {
		const name = newPageName();
		await page.goto(`/${name}`);
		await clickLineEnd(page, 0);
		await page.keyboard.press("Enter");
		await page.keyboard.type("最初の行");
		await expect(status(page)).toHaveText("保存済み");

		const other = await context.newPage();
		await other.goto(`/${name}`);
		await expectLines(other, [name, "最初の行"]);
		return { name, other };
	}

	test("別のタブで書いた内容が、何もしなくてもその場で届く", async ({ page, context }) => {
		const { name, other } = await openInTwoTabs(page, context);

		await clickLineEnd(other, 1);
		await other.keyboard.press("Enter");
		await other.keyboard.type("別のタブの行");

		// 最初のタブは、何も操作していない。
		await expectLines(page, [name, "最初の行", "別のタブの行"]);
		await expect(status(page)).toHaveText("保存済み");
	});

	test("2つのタブで別々の行を書いても、どちらの変更も残り、両方の画面が同じになる", async ({
		page,
		context,
	}) => {
		const { name, other } = await openInTwoTabs(page, context);

		await clickLineEnd(page, 0);
		await clickLineEnd(other, 1);
		for (const letter of ["1", "2", "3"]) {
			await page.keyboard.type(letter);
			await other.keyboard.type(letter);
		}

		const expected = [`${name}123`, "最初の行123"];
		await expectLines(page, expected);
		await expectLines(other, expected);
		await page.reload();
		await expectLines(page, expected);
	});

	test("他の人の変更が届いても、自分のカーソルは同じ行に残り、続けて書ける", async ({
		page,
		context,
	}) => {
		const { name, other } = await openInTwoTabs(page, context);
		await clickLineEnd(page, 1);

		// 別のタブが、カーソルのある行より上に行を足す。
		await clickLineEnd(other, 0);
		await other.keyboard.press("Enter");
		await other.keyboard.type("上に足した行");
		await expectLines(page, [name, "上に足した行", "最初の行"]);

		await page.keyboard.type("!");

		await expectLines(page, [name, "上に足した行", "最初の行!"]);
		await expectLines(other, [name, "上に足した行", "最初の行!"]);
	});

	test("まだないページを開いているあいだに他の人が書くと、その内容が表示される", async ({
		page,
		context,
	}) => {
		const name = newPageName();
		await page.goto(`/${name}`);
		await expect(status(page)).toHaveText("新しいページです。書き始めると保存されます");
		const other = await context.newPage();
		await other.goto(`/${name}`);

		await clickLineEnd(other, 0);
		await other.keyboard.type(" を先に書いた");

		await expectLines(page, [`${name} を先に書いた`]);
		await expect(status(page)).toHaveText("保存済み");
	});
});
