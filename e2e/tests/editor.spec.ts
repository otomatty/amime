import { expect, type Page, test } from "@playwright/test";

const lines = (page: Page) => page.getByTestId("line");
const lineTexts = (page: Page) =>
	lines(page).evaluateAll((elements) => elements.map((el) => el.getAttribute("data-text")));

/** 指定した行の末尾の余白を押して、カーソルを行末に置く。 */
async function clickLineEnd(page: Page, index: number) {
	const box = await lines(page).nth(index).boundingBox();
	if (!box) throw new Error(`line ${index} is not visible`);
	await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
}

test.describe("エディタ", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("行を押して文字を打つと、その行の末尾に入る", async ({ page }) => {
		await clickLineEnd(page, 0);

		await page.keyboard.type("abc");

		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめにabc");
	});

	test("文字の左半分を押すとその前に、右半分を押すとその後ろにカーソルが入る", async ({ page }) => {
		const char = lines(page).first().locator(".char").nth(1); // 「じ」
		const box = await char.boundingBox();
		if (!box) throw new Error("char is not visible");

		await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
		await page.keyboard.type("1");
		await expect(lines(page).first()).toHaveAttribute("data-text", "は1じめに");

		const again = await lines(page).first().locator(".char").nth(2).boundingBox(); // 「じ」
		if (!again) throw new Error("char is not visible");
		await page.mouse.click(again.x + again.width * 0.75, again.y + again.height / 2);
		await page.keyboard.type("2");
		await expect(lines(page).first()).toHaveAttribute("data-text", "は1じ2めに");
	});

	test("インデントされた行で改行すると、次の行も同じ深さで始まる", async ({ page }) => {
		await clickLineEnd(page, 3); // 「  2段目」

		await page.keyboard.press("Enter");
		await page.keyboard.type("続き");

		expect((await lineTexts(page)).slice(3, 5)).toEqual(["  2段目", "  続き"]);
		await expect(lines(page).nth(4)).toHaveAttribute("data-indent", "2");
	});

	test("Tab と Shift+Tab でインデントを変えられる", async ({ page }) => {
		await clickLineEnd(page, 0);

		await page.keyboard.press("Tab");
		await expect(lines(page).first()).toHaveAttribute("data-indent", "1");

		await page.keyboard.press("Shift+Tab");
		await expect(lines(page).first()).toHaveAttribute("data-indent", "0");
	});

	test("行頭で Backspace を押すと、前の行とつながる", async ({ page }) => {
		await clickLineEnd(page, 1);
		await page.keyboard.press("Home");

		await page.keyboard.press("Backspace");

		await expect(lines(page).first()).toHaveAttribute(
			"data-text",
			"はじめに行頭に空白を入れると箇条書きになります",
		);
	});

	test("矢印キーでカーソルを動かせる", async ({ page }) => {
		await clickLineEnd(page, 0);

		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.type("x");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.type("y");

		expect((await lineTexts(page)).slice(0, 2)).toEqual([
			"はじxめに",
			"行頭にy空白を入れると箇条書きになります",
		]);
	});

	test("カーソルは、入力中の位置に表示される", async ({ page }) => {
		await clickLineEnd(page, 2); // 「 1段目」

		const caret = page.getByTestId("caret");
		const lastChar = lines(page).nth(2).locator(".char").last();
		const caretBox = await caret.boundingBox();
		const charBox = await lastChar.boundingBox();

		expect(caretBox?.x).toBeCloseTo((charBox?.x ?? 0) + (charBox?.width ?? 0), 0);
		await expect(page.getByTestId("editor")).toHaveAttribute("data-focused", "true");
	});

	test("折り返した行は、インデントの位置で揃う", async ({ page }) => {
		await page.setViewportSize({ width: 420, height: 800 });
		await clickLineEnd(page, 2); // 「 1段目」
		await page.keyboard.type("あ".repeat(60));

		const chars = lines(page).nth(2).locator(".char");
		const first = await chars.first().boundingBox();
		const last = await chars.last().boundingBox();

		expect(last?.y).toBeGreaterThan(first?.y ?? Number.POSITIVE_INFINITY);
		const xs = await chars.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
		expect(Math.min(...xs)).toBeCloseTo(first?.x ?? -1, 0);
	});
});

test.describe("エディタ(画面の操作)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("折り返した行の1段目の右の余白を押すと、1段目の末尾にカーソルが入る", async ({ page }) => {
		await page.setViewportSize({ width: 420, height: 800 });
		await clickLineEnd(page, 2); // 「 1段目」
		await page.keyboard.type("あ".repeat(60));
		await page.keyboard.press("Escape");

		const chars = lines(page).nth(2).locator(".char");
		const first = await chars.first().boundingBox();
		const line = await lines(page).nth(2).boundingBox();
		if (!first || !line) throw new Error("line is not visible");
		const firstRow = await chars.evaluateAll(
			(els, top) => els.filter((el) => el.getBoundingClientRect().top === top).length,
			first.y,
		);

		await page.mouse.click(line.x + line.width - 2, first.y + first.height / 2);
		await page.keyboard.type("|");

		const text = await lines(page).nth(2).getAttribute("data-text");
		// 「 」(インデント)+ 1段目の文字数 の位置に入る。行全体の末尾ではない。
		expect(text?.indexOf("|")).toBe(1 + firstRow);
		expect(text?.endsWith("|")).toBe(false);
	});

	test("Enter を続けて押して画面の下に達しても、カーソルが見える位置までスクロールする", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 800, height: 400 });
		await clickLineEnd(page, 0);

		for (let i = 0; i < 30; i++) await page.keyboard.press("Enter");

		await expect(page.getByTestId("caret")).toBeInViewport();
	});

	test("Esc で編集欄から抜け、Shift+Tab で前の要素へフォーカスを移せる", async ({ page }) => {
		// いまの画面には編集欄の前にフォーカスできる要素がないため、確認用のボタンを置く。
		await page.evaluate(() => {
			const button = document.createElement("button");
			button.textContent = "前の要素";
			document.querySelector("main")?.prepend(button);
		});
		await clickLineEnd(page, 0);

		await page.keyboard.press("Escape");
		await page.keyboard.press("Shift+Tab");

		await expect(page.getByRole("button", { name: "前の要素" })).toBeFocused();
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");
	});

	test("Esc で編集欄から抜け、Tab で本文中の最初のリンクへフォーカスを移せる", async ({ page }) => {
		await clickLineEnd(page, 0);

		await page.keyboard.press("Escape");
		await page.keyboard.press("Tab");

		await expect(page.getByRole("link", { name: "リンク", exact: true })).toBeFocused();
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");
	});
});

test.describe("記法の表示", () => {
	const LINK_LINE = 6; // 「[リンク] や #タグ でページをつなげます」
	const DECORATION_LINE = 7; // 「[* 太字] [/ 斜体] …」

	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("カーソルのない行は記法を隠して装飾し、行を押すと記法がそのまま見える", async ({ page }) => {
		const line = lines(page).nth(LINK_LINE);
		await expect(line).toHaveText("リンク や #タグ でページをつなげます");
		await expect(line.getByRole("link", { name: "リンク", exact: true })).toBeVisible();

		await clickLineEnd(page, LINK_LINE);

		await expect(line).toHaveText("[リンク] や #タグ でページをつなげます");
		await expect(line.getByRole("link")).toHaveCount(0);
	});

	test("別の行へ移ると、元の行は装飾した表示に戻る", async ({ page }) => {
		await clickLineEnd(page, LINK_LINE);
		await page.keyboard.press("ArrowUp");

		await expect(lines(page).nth(LINK_LINE)).toHaveText("リンク や #タグ でページをつなげます");
	});

	test("装飾は見た目に反映される", async ({ page }) => {
		const line = lines(page).nth(DECORATION_LINE);

		await expect(line.locator('.deco[data-deco="*"]')).toHaveCSS("font-weight", "700");
		await expect(line.locator('.deco[data-deco="/"]')).toHaveCSS("font-style", "italic");
		await expect(line.locator('.deco[data-deco="-"]')).toHaveCSS(
			"text-decoration-line",
			"line-through",
		);
		await expect(line.locator('.deco[data-deco="_"]')).toHaveCSS(
			"text-decoration-line",
			"underline",
		);
		await expect(line.locator("strong")).toHaveText("強調");
		await expect(line.locator("code")).toHaveText("code");
	});

	test("装飾された文字を押すと、その文字の位置にカーソルが入る", async ({ page }) => {
		const bold = lines(page).nth(DECORATION_LINE).locator('.deco[data-deco="*"] .char');
		const box = await bold.last().boundingBox(); // 「太字」の「字」
		if (!box) throw new Error("char is not visible");

		await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
		await page.keyboard.type("!");

		await expect(lines(page).nth(DECORATION_LINE)).toHaveAttribute("data-text", /^\[\* 太字!\] /);
	});

	test("記法で終わる行の右の余白を押すと、記法の後ろ(行末)にカーソルが入る", async ({ page }) => {
		await clickLineEnd(page, DECORATION_LINE); // 「… `code`」で終わる行

		await page.keyboard.type("!");

		await expect(lines(page).nth(DECORATION_LINE)).toHaveAttribute("data-text", /`code`!$/);
	});

	test("リンクを押すと、カーソルを置かずにそのページへ移動する", async ({ page }) => {
		await lines(page).nth(LINK_LINE).getByRole("link", { name: "リンク", exact: true }).click();

		await expect(page).toHaveURL(/\/%E3%83%AA%E3%83%B3%E3%82%AF$/);
	});

	test("外部リンクは別のタブで開く設定になっている", async ({ page }) => {
		const link = page.getByRole("link", { name: "Cloudflare" });

		await expect(link).toHaveAttribute("href", "https://www.cloudflare.com/");
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	test("1行目はタイトルとして大きく表示し、記法を解釈しない", async ({ page }) => {
		await clickLineEnd(page, 0);
		await page.keyboard.type(" [x]");
		await page.keyboard.press("ArrowDown");

		const title = lines(page).first();
		await expect(title).toHaveText("はじめに [x]");
		await expect(title.getByRole("link")).toHaveCount(0);
		const titleSize = await title.evaluate((el) =>
			Number.parseFloat(getComputedStyle(el).fontSize),
		);
		const bodySize = await lines(page)
			.nth(1)
			.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
		expect(titleSize).toBeGreaterThan(bodySize);
	});
});

test.describe("日本語入力(IME)", () => {
	// 実際のIMEと同じイベント列を、Chromium の開発者ツール用の通信(CDP)で発生させる。
	// CDP は Chromium でしか使えない。他のブラウザを対象に加えるときは、このブロックを Chromium 限定にすること。

	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("変換中の文字列はカーソル位置に下線付きで表示され、確定すると1回だけ入る", async ({
		page,
	}) => {
		const cdp = await page.context().newCDPSession(page);
		await clickLineEnd(page, 0);

		await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
		await cdp.send("Input.imeSetComposition", {
			text: "にほんご",
			selectionStart: 4,
			selectionEnd: 4,
		});

		const composing = page.getByTestId("composing");
		await expect(composing).toHaveText("にほんご");
		await expect(composing).toHaveCSS("text-decoration-line", "underline");
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");

		await cdp.send("Input.insertText", { text: "日本語" });

		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに日本語");
		await expect(composing).toHaveCount(0);
	});

	test("確定のあと、続けて入力と変換ができる", async ({ page }) => {
		const cdp = await page.context().newCDPSession(page);
		await clickLineEnd(page, 0);

		await cdp.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
		await cdp.send("Input.insertText", { text: "亜" });
		await page.keyboard.type("x");
		await cdp.send("Input.imeSetComposition", { text: "い", selectionStart: 1, selectionEnd: 1 });
		await cdp.send("Input.insertText", { text: "位" });

		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに亜x位");
	});

	test("変換を取り消すと、何も入らない", async ({ page }) => {
		const cdp = await page.context().newCDPSession(page);
		await clickLineEnd(page, 0);

		await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
		await expect(page.getByTestId("composing")).toHaveText("にほ");
		await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });

		await expect(page.getByTestId("composing")).toHaveCount(0);
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");
	});

	test("入力を受け取る欄は、変換候補が近くに出るようカーソルの位置に重なっている", async ({
		page,
	}) => {
		await clickLineEnd(page, 3);

		const caret = await page.getByTestId("caret").boundingBox();
		const input = await page.getByLabel("ページの本文").boundingBox();

		expect(Math.abs((input?.x ?? 0) - (caret?.x ?? 999))).toBeLessThan(4);
		expect(Math.abs((input?.y ?? 0) - (caret?.y ?? 999))).toBeLessThan(16);
	});
});
