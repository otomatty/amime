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

test.describe("コードブロックとテーブル", () => {
	const CODE_HEAD = 10; // 「code:hello.js」
	const CODE_BODY = 12; // 「   return items[0]; // [リンク] にはならない」
	const TABLE_HEAD = 14; // 「table:今週の予定」
	const TABLE_ROW_1 = 15; // 「 月	火	水」
	const TABLE_ROW_2 = 16; // 「 [定例会議]	`deploy`	お休み」

	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("コードブロックの始まりの行は名前だけを表示し、押すと code: も見える", async ({ page }) => {
		const head = lines(page).nth(CODE_HEAD);
		await expect(head).toHaveText("hello.js");

		await clickLineEnd(page, CODE_HEAD);

		await expect(head).toHaveText("code:hello.js");
	});

	test("コードブロックの中身は等幅の文字で、記法を解釈せずに表示する", async ({ page }) => {
		const body = lines(page).nth(CODE_BODY);

		await expect(body).toHaveAttribute("data-kind", "code-body");
		await expect(body.locator(".code-text")).toHaveText(
			"  return items[0]; // [リンク] にはならない",
		);
		await expect(body.getByRole("link")).toHaveCount(0);
		await expect(body.locator(".code-text")).toHaveCSS("font-family", /monospace/);
	});

	test("コードの字下げは、そのままの幅で表示される", async ({ page }) => {
		const first = await lines(page)
			.nth(CODE_BODY - 1)
			.locator(".char")
			.first()
			.boundingBox();
		const nested = await lines(page).nth(CODE_BODY).locator(".char").nth(2).boundingBox(); // 「r」

		expect(nested?.x).toBeGreaterThan(first?.x ?? Number.POSITIVE_INFINITY);
	});

	test("コードブロックの下で字下げをやめると、普通の行に戻る", async ({ page }) => {
		await clickLineEnd(page, CODE_BODY + 1); // 「 }」
		await page.keyboard.press("Enter");
		await page.keyboard.type("x");
		await expect(lines(page).nth(CODE_BODY + 2)).toHaveAttribute("data-kind", "code-body");

		await page.keyboard.press("Shift+Tab");

		await expect(lines(page).nth(CODE_BODY + 2)).toHaveAttribute("data-kind", "text");
	});

	test("テーブルは、行が違っても列の位置がそろう", async ({ page }) => {
		await expect(lines(page).nth(TABLE_HEAD)).toHaveText("今週の予定");
		const lefts = async (row: number) =>
			lines(page)
				.nth(row)
				.locator(".cell-text")
				.evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().left)));

		const first = await lefts(TABLE_ROW_1);
		const second = await lefts(TABLE_ROW_2);

		expect(first).toHaveLength(3);
		expect(second).toEqual(first);
		expect(first[1]).toBeGreaterThan(first[0] ?? Number.POSITIVE_INFINITY);
	});

	test("テーブルのセルの中でも、記法が表示される", async ({ page }) => {
		const row = lines(page).nth(TABLE_ROW_2);

		await expect(row.getByRole("link", { name: "定例会議" })).toBeVisible();
		await expect(row.locator("code")).toHaveText("deploy");
	});

	test("セルの左の余白を押すと、そのセルの先頭にカーソルが入る", async ({ page }) => {
		const cell = lines(page).nth(TABLE_ROW_1).locator(".cell").nth(2); // 「火」のセル
		const box = await cell.boundingBox();
		if (!box) throw new Error("cell is not visible");

		await page.mouse.click(box.x + 2, box.y + box.height / 2);
		await page.keyboard.type("毎");

		await expect(lines(page).nth(TABLE_ROW_1)).toHaveAttribute("data-text", " 月\t毎火\t水");
	});

	test("セルの余白を押すと、そのセルの末尾にカーソルが入る", async ({ page }) => {
		// 1行目の1列目「月」は、2行目の「定例会議」より短いので、右に余白がある。
		const cell = lines(page).nth(TABLE_ROW_1).locator(".cell").nth(1);
		const box = await cell.boundingBox();
		if (!box) throw new Error("cell is not visible");

		await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
		await page.keyboard.type("曜");

		await expect(lines(page).nth(TABLE_ROW_1)).toHaveAttribute("data-text", " 月曜\t火\t水");
	});

	test("テーブルの行で Tab を押すと、新しいセルができる", async ({ page }) => {
		await clickLineEnd(page, TABLE_ROW_1);

		await page.keyboard.press("Tab");
		await page.keyboard.type("木");

		await expect(lines(page).nth(TABLE_ROW_1)).toHaveAttribute("data-text", " 月\t火\t水\t木");
		await expect(lines(page).nth(TABLE_ROW_1).locator(".cell-text")).toHaveCount(4);
	});

	test("テーブルの行で Enter を押すと、次の行もテーブルの行になる", async ({ page }) => {
		await clickLineEnd(page, TABLE_ROW_2);

		await page.keyboard.press("Enter");
		await page.keyboard.type("a");

		const added = lines(page).nth(TABLE_ROW_2 + 1);
		await expect(added).toHaveAttribute("data-kind", "table-row");
		await expect(added).toHaveAttribute("data-text", " a");
		await expect(added.getByTestId("caret")).toHaveCount(1);
	});

	test("$ で始まる行は、コマンドとして表示する", async ({ page }) => {
		await expect(page.locator("code.command-line")).toHaveText("$ pnpm dev");
	});
});

test.describe("テーブルの端の扱い", () => {
	const TABLE_ROW_1 = 15; // 「 月	火	水」
	const TABLE_ROW_2 = 16; // 「 [定例会議]	`deploy`	お休み」

	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("記法で始まるセルの左の余白を押すと、記法の前にカーソルが入る", async ({ page }) => {
		const cell = lines(page).nth(TABLE_ROW_2).locator(".cell").nth(1); // 「[定例会議]」のセル
		const box = await cell.boundingBox();
		if (!box) throw new Error("cell is not visible");

		await page.mouse.click(box.x + 2, box.y + box.height / 2);
		await page.keyboard.type("x");

		await expect(lines(page).nth(TABLE_ROW_2)).toHaveAttribute(
			"data-text",
			" x[定例会議]\t`deploy`\tお休み",
		);
	});

	test("テーブルの右の、行のない場所を押すと、文書の末尾ではなくその行の末尾にカーソルが入る", async ({
		page,
	}) => {
		const editor = await page.getByTestId("editor").boundingBox();
		const row = await lines(page).nth(TABLE_ROW_1).boundingBox();
		if (!editor || !row) throw new Error("editor is not visible");

		await page.mouse.click(editor.x + editor.width - 4, row.y + row.height / 2);
		await page.keyboard.type("!");

		await expect(lines(page).nth(TABLE_ROW_1)).toHaveAttribute("data-text", " 月\t火\t水!");
	});

	test("テーブルの行で文字を選択して Tab を押しても、選択した文字は消えずにインデントされる", async ({
		page,
	}) => {
		await clickLineEnd(page, TABLE_ROW_1);
		await page.keyboard.press("Shift+ArrowLeft");

		await page.keyboard.press("Tab");

		await expect(lines(page).nth(TABLE_ROW_1)).toHaveAttribute("data-text", "  月\t火\t水");
	});

	test("先頭のセルの頭で Tab を押すと、空の先頭セルができる", async ({ page }) => {
		await clickLineEnd(page, TABLE_ROW_1);
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowRight"); // インデントの後ろ = 先頭のセルの頭

		await page.keyboard.press("Tab");

		const row = lines(page).nth(TABLE_ROW_1);
		await expect(row).toHaveAttribute("data-text", " \t月\t火\t水");
		await expect(row.locator(".cell-text")).toHaveCount(4);
		await expect(row.locator(".cell-text").first()).toHaveText("");
	});

	test("空の先頭セルがある行で Enter を押しても、新しい行は先頭のセルから始まる", async ({
		page,
	}) => {
		await clickLineEnd(page, TABLE_ROW_1);
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Tab");
		await page.keyboard.press("End");

		await page.keyboard.press("Enter");
		await page.keyboard.type("a");

		await expect(lines(page).nth(TABLE_ROW_1 + 1)).toHaveAttribute("data-text", " a");
	});
});

test.describe("範囲選択・コピー・取り消し", () => {
	const selectedText = (page: Page) =>
		page
			.locator("[data-column].selected")
			.evaluateAll((elements) => elements.map((el) => el.textContent).join(""));

	test.beforeEach(async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("/");
	});

	test("Shift+矢印で選択した範囲に色が付き、文字を打つと置き換わる", async ({ page }) => {
		await clickLineEnd(page, 1); // 「行頭に空白を入れると箇条書きになります」
		await page.keyboard.press("Home");

		await page.keyboard.press("Shift+ArrowRight");
		await page.keyboard.press("Shift+ArrowRight");

		expect(await selectedText(page)).toBe("行頭");
		const selected = page.locator("[data-column].selected").first();
		const plain = lines(page).nth(1).locator(".char:not(.selected)").first();
		expect(await selected.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
			await plain.evaluate((el) => getComputedStyle(el).backgroundColor),
		);

		await page.keyboard.type("先頭");
		await expect(lines(page).nth(1)).toHaveAttribute(
			"data-text",
			"先頭に空白を入れると箇条書きになります",
		);
	});

	test("マウスで押したまま動かすと、行をまたいで選択できる", async ({ page }) => {
		const from = await lines(page).nth(2).locator(".char").first().boundingBox(); // 「1段目」の「1」
		const to = await lines(page).nth(3).locator(".char").nth(1).boundingBox(); // 「2段目」の「段」
		if (!from || !to) throw new Error("chars are not visible");

		await page.mouse.move(from.x + 1, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(to.x + to.width * 0.25, to.y + to.height / 2, { steps: 5 });
		await page.mouse.up();

		expect(await selectedText(page)).toBe("1段目2");
		await expect(page.locator(".line-break.selected")).toHaveCount(1);

		await page.keyboard.press("Backspace");
		await expect(lines(page).nth(2)).toHaveAttribute("data-text", " 段目");
	});

	test("Shift を押しながら別の位置を押すと、そこまでを選択する", async ({ page }) => {
		await clickLineEnd(page, 1);
		const box = await lines(page).nth(1).locator(".char").nth(2).boundingBox(); // 「に」
		if (!box) throw new Error("char is not visible");

		await page.keyboard.down("Shift");
		await page.mouse.click(box.x + 1, box.y + box.height / 2);
		await page.keyboard.up("Shift");

		expect(await selectedText(page)).toBe("に空白を入れると箇条書きになります");
	});

	test("コピーして貼り付けると、選択した文字列が複製される", async ({ page }) => {
		await clickLineEnd(page, 0);
		await page.keyboard.press("Shift+Home");
		expect(await selectedText(page)).toBe("はじめに");

		await page.keyboard.press("ControlOrMeta+c");
		await page.keyboard.press("End");
		await page.keyboard.press("ControlOrMeta+v");

		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめにはじめに");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("はじめに");
	});

	test("複数行を切り取って、別の場所に貼り付けられる(記法やインデントもそのまま)", async ({
		page,
	}) => {
		await clickLineEnd(page, 2); // 「 1段目」
		await page.keyboard.press("Home");
		await page.keyboard.press("Shift+ArrowDown");
		await page.keyboard.press("Shift+End");

		await page.keyboard.press("ControlOrMeta+x");
		expect((await lineTexts(page)).slice(1, 3)).toEqual([
			"行頭に空白を入れると箇条書きになります",
			"",
		]);
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(" 1段目\n  2段目");

		await clickLineEnd(page, 0);
		await page.keyboard.press("Enter");
		await page.keyboard.press("ControlOrMeta+v");
		expect((await lineTexts(page)).slice(0, 3)).toEqual(["はじめに", " 1段目", "  2段目"]);
	});

	test("Ctrl+A ですべてを選択できる", async ({ page }) => {
		await clickLineEnd(page, 0);

		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("x");

		expect(await lineTexts(page)).toEqual(["x"]);
	});

	test("複数行を選択して Tab を押すと、まとめてインデントされる", async ({ page }) => {
		await clickLineEnd(page, 5); // 「この画面で自由に編集できます…」
		await page.keyboard.press("Shift+ArrowDown");

		await page.keyboard.press("Tab");

		await expect(lines(page).nth(5)).toHaveAttribute("data-indent", "1");
		await expect(lines(page).nth(6)).toHaveAttribute("data-indent", "1");
		await page.keyboard.press("Shift+Tab");
		await expect(lines(page).nth(5)).toHaveAttribute("data-indent", "0");
		await expect(lines(page).nth(6)).toHaveAttribute("data-indent", "0");
	});

	test("Ctrl+Z で取り消し、Ctrl+Shift+Z と Ctrl+Y(Mac 以外)でやり直せる", async ({ page }) => {
		await clickLineEnd(page, 0);
		await page.keyboard.type("abc");
		await page.keyboard.press("Enter");
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめにabc");

		await page.keyboard.press("ControlOrMeta+z");
		expect((await lineTexts(page))[1]).toBe("行頭に空白を入れると箇条書きになります");
		await page.keyboard.press("ControlOrMeta+z");
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");

		await page.keyboard.press("ControlOrMeta+Shift+z");
		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめにabc");
		// Y でのやり直しは Mac 以外だけにある(ADR-0014)。Mac では Shift+Z で確かめる。
		const redoKey = process.platform === "darwin" ? "Meta+Shift+z" : "Control+y";
		await page.keyboard.press(redoKey);
		expect((await lineTexts(page))[1]).toBe("");
	});

	test("選択して置き換えたあとに取り消すと、選択した状態まで戻る", async ({ page }) => {
		await clickLineEnd(page, 0);
		await page.keyboard.press("Shift+Home");
		await page.keyboard.type("x");
		await expect(lines(page).first()).toHaveAttribute("data-text", "x");

		await page.keyboard.press("ControlOrMeta+z");

		await expect(lines(page).first()).toHaveAttribute("data-text", "はじめに");
		expect(await selectedText(page)).toBe("はじめに");
	});
});

test.describe("行とかたまりを動かす", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("Alt+下で、行を子の行ごと次の行の下へ動かせる。カーソルは行についていく", async ({
		page,
	}) => {
		await clickLineEnd(page, 1); // 子の行が3つある行

		await page.keyboard.press("Alt+ArrowDown");
		await page.keyboard.type("!");

		expect((await lineTexts(page)).slice(1, 6)).toEqual([
			"この画面で自由に編集できます(まだ保存はされません)",
			"行頭に空白を入れると箇条書きになります!",
			" 1段目",
			"  2段目",
			" \t全角スペースやタブも同じ深さとして数えます",
		]);
	});

	test("Alt+上で元の位置へ戻せる", async ({ page }) => {
		const before = await lineTexts(page);
		await clickLineEnd(page, 1);

		await page.keyboard.press("Alt+ArrowDown");
		await page.keyboard.press("Alt+ArrowUp");

		expect(await lineTexts(page)).toEqual(before);
	});

	test("Ctrl+下では、カーソルのある行だけが動く(子の行はその場に残る)", async ({ page }) => {
		await clickLineEnd(page, 1);

		await page.keyboard.press("Control+ArrowDown");

		expect((await lineTexts(page)).slice(1, 4)).toEqual([
			" 1段目",
			"行頭に空白を入れると箇条書きになります",
			"  2段目",
		]);
	});

	test("複数行を選択して Ctrl+上を押すと、選択した行がまとめて動く", async ({ page }) => {
		await clickLineEnd(page, 2);
		await page.keyboard.press("Shift+ArrowDown");

		await page.keyboard.press("Control+ArrowUp");

		expect((await lineTexts(page)).slice(1, 4)).toEqual([
			" 1段目",
			"  2段目",
			"行頭に空白を入れると箇条書きになります",
		]);
		await expect(lines(page).nth(1).locator(".selected").first()).toBeVisible();
	});

	test("かたまりを動かしたあと、取り消すと1回で元に戻る", async ({ page }) => {
		const before = await lineTexts(page);
		await clickLineEnd(page, 1);

		await page.keyboard.press("Alt+ArrowDown");
		await page.keyboard.press("ControlOrMeta+z");

		expect(await lineTexts(page)).toEqual(before);
	});

	test("文書の末尾と先頭へ、キーで移動できる", async ({ page }) => {
		// Mac では Command+上下、それ以外では Ctrl+Home / End(ADR-0015)。
		const mac = process.platform === "darwin";
		await clickLineEnd(page, 3);

		await page.keyboard.press(mac ? "Meta+ArrowDown" : "Control+End");
		await page.keyboard.type("末尾");
		await expect(lines(page).last()).toHaveAttribute("data-text", "$ pnpm dev末尾");

		await page.keyboard.press(mac ? "Meta+ArrowUp" : "Control+Home");
		await page.keyboard.type("先頭");
		await expect(lines(page).first()).toHaveAttribute("data-text", "先頭はじめに");
	});
});
