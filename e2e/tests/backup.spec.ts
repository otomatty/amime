import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

/** API でページを作る(本文を送る)。戻り値は、ページID。 */
async function createPage(page: Page, title: string, lines: readonly string[]): Promise<string> {
	const opened = await page.request.get(
		`/api/projects/e2e/pages/by-title/${encodeURIComponent(title)}`,
	);
	const { id } = (await opened.json()) as { id: string };
	const changes = [title, ...lines].map((text, index) => ({
		type: "insert",
		line: { id: `l${index}`, text },
		after: index === 0 ? null : `l${index - 1}`,
		before: null,
	}));
	const saved = await page.request.post(`/api/projects/e2e/pages/${id}/commits`, {
		data: { id: randomUUID(), client: randomUUID(), changes },
	});
	expect(saved.ok()).toBe(true);
	return id;
}

type ExportedFile = {
	format: string;
	pages: { title: string; lines: string[]; pinned: boolean }[];
};

test.describe("プロジェクトの書き出しと読み込み(ADR-0043、US-14)", () => {
	test("書き出したファイルに、すべてのページの本文が入る。消したページは、読み込むと元に戻る", async ({
		page,
	}) => {
		const token = randomUUID().slice(0, 8);
		const kept = `${token}-残す`;
		const removed = `${token}-消す`;
		await createPage(page, kept, ["残すページの本文", " [リンク]"]);
		const removedId = await createPage(page, removed, ["消すページの本文", "code:a.js", " x = 1"]);

		// 一覧(台帳)に載るのは、保存の少しあと。載ってから書き出す。
		await expect
			.poll(async () => {
				const found = await page.request.get(`/api/projects/e2e/pages/titles?q=${token}`);
				return ((await found.json()) as { titles: string[] }).titles.length;
			})
			.toBe(2);

		// 書き出す。
		await page.goto("/settings/e2e");
		const downloading = page.waitForEvent("download");
		await page.getByRole("button", { name: "書き出す" }).click();
		const download = await downloading;
		expect(download.suggestedFilename()).toMatch(/^tsuzuri-e2e-\d{4}-\d{2}-\d{2}\.json$/);
		await expect(
			page.getByRole("status").filter({ hasText: "ページを書き出しました" }),
		).toBeVisible();
		const exported = JSON.parse(await readFile(await download.path(), "utf8")) as ExportedFile;
		expect(exported.format).toBe("tsuzuri-project");
		const ours = exported.pages.filter((entry) => entry.title.startsWith(token));
		expect(ours).toEqual(
			expect.arrayContaining([
				{
					title: kept,
					lines: [kept, "残すページの本文", " [リンク]"],
					pinned: false,
					created: expect.any(Number),
					updated: expect.any(Number),
				},
				{
					title: removed,
					lines: [removed, "消すページの本文", "code:a.js", " x = 1"],
					pinned: false,
					created: expect.any(Number),
					updated: expect.any(Number),
				},
			]),
		);

		// ページを1つ消してから、このテストのページだけのファイルを読み込む(E2E用のプロジェクトには、ほかのテストのページもある)。
		expect((await page.request.delete(`/api/projects/e2e/pages/${removedId}`)).ok()).toBe(true);
		await page.getByLabel("読み込むファイル").setInputFiles({
			name: "backup.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({ ...exported, pages: ours })),
		});
		await expect(page.getByText(/「e2e」から書き出した 2 ページです/)).toBeVisible();
		await page.getByRole("button", { name: "読み込む", exact: true }).click();

		await expect(
			page.getByRole("status").filter({ hasText: "1 ページを作りました。" }),
		).toBeVisible();
		await expect(
			page.getByText(`同じ名前のページがあったので、書き換えずに飛ばしました: ${kept}`),
		).toBeVisible();

		// 消したページが、同じ本文で戻っている(画面ではなく、保存された行で比べる。コードの行は、記号を隠して表示する)。
		const reopened = await page.request.get(
			`/api/projects/e2e/pages/by-title/${encodeURIComponent(removed)}`,
		);
		const { id } = (await reopened.json()) as { id: string };
		const snapshot = await page.request.get(`/api/projects/e2e/pages/${id}`);
		const { lines } = (await snapshot.json()) as { lines: { text: string }[] };
		expect(lines.map((line) => line.text)).toEqual([
			removed,
			"消すページの本文",
			"code:a.js",
			" x = 1",
		]);
		await page.goto(`/e2e/${encodeURIComponent(removed)}`);
		await expect(page.getByTestId("line").first()).toHaveText(removed);
	});
});
