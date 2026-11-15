import { describe, expect, it } from "vitest";
import { type Budget, checkBudgets, formatReport } from "./size-budget.ts";

const KIB = 1024;

const budgets: Budget[] = [
	{ name: "画面のJS", pattern: /^assets\/assets\/.*\.js$/, maxGzipBytes: 100 * KIB },
	{ name: "画面のCSS", pattern: /^assets\/assets\/.*\.css$/, maxGzipBytes: 10 * KIB },
];

describe("checkBudgets", () => {
	it("型ごとに、当てはまるファイルの大きさを足して、上限と比べる", () => {
		const results = checkBudgets(
			[
				{ path: "assets/assets/index-a.js", gzipBytes: 60 * KIB },
				{ path: "assets/assets/chunk-b.js", gzipBytes: 30 * KIB },
				{ path: "assets/assets/index-c.css", gzipBytes: 4 * KIB },
			],
			budgets,
		);

		expect(results).toEqual([
			{ name: "画面のJS", files: 2, gzipBytes: 90 * KIB, maxGzipBytes: 100 * KIB, ok: true },
			{ name: "画面のCSS", files: 1, gzipBytes: 4 * KIB, maxGzipBytes: 10 * KIB, ok: true },
		]);
	});

	it("上限を超えたら ok は false。上限ちょうどは、通す", () => {
		const [js, css] = checkBudgets(
			[
				{ path: "assets/assets/index-a.js", gzipBytes: 100 * KIB + 1 },
				{ path: "assets/assets/index-c.css", gzipBytes: 10 * KIB },
			],
			budgets,
		);

		expect(js?.ok).toBe(false);
		expect(css?.ok).toBe(true);
	});

	it("どの型にも当てはまらないファイル(ソースマップなど)は数えない", () => {
		const [js] = checkBudgets(
			[
				{ path: "assets/assets/index-a.js", gzipBytes: KIB },
				{ path: "assets/assets/index-a.js.map", gzipBytes: 500 * KIB },
				{ path: "bundle/index.js", gzipBytes: 500 * KIB },
			],
			budgets,
		);

		expect(js).toMatchObject({ files: 1, gzipBytes: KIB, ok: true });
	});

	it("当てはまるファイルが1つもない型は、ビルドの出力が変わったとみなして ok を false にする", () => {
		const results = checkBudgets([{ path: "assets/assets/index-a.js", gzipBytes: KIB }], budgets);

		expect(results[1]).toEqual({
			name: "画面のCSS",
			files: 0,
			gzipBytes: 0,
			maxGzipBytes: 10 * KIB,
			ok: false,
		});
	});
});

describe("formatReport", () => {
	it("Markdown の表にする。大きさは KiB で、小数1桁", () => {
		const report = formatReport([
			{ name: "画面のJS", files: 2, gzipBytes: 90 * KIB + 512, maxGzipBytes: 100 * KIB, ok: true },
			{ name: "画面のCSS", files: 1, gzipBytes: 11 * KIB, maxGzipBytes: 10 * KIB, ok: false },
		]);

		expect(report).toBe(
			[
				"| 対象 | ファイル数 | 大きさ(gzip) | 上限 | 結果 |",
				"| --- | ---: | ---: | ---: | --- |",
				"| 画面のJS | 2 | 90.5 KiB | 100.0 KiB | ✅ |",
				"| 画面のCSS | 1 | 11.0 KiB | 10.0 KiB | ❌ 超過 |",
			].join("\n"),
		);
	});

	it("ファイルが見つからなかった型は、そのことを書く", () => {
		const report = formatReport([
			{ name: "画面のCSS", files: 0, gzipBytes: 0, maxGzipBytes: 10 * KIB, ok: false },
		]);

		expect(report.split("\n")[2]).toBe(
			"| 画面のCSS | 0 | 0.0 KiB | 10.0 KiB | ❌ ファイルがない |",
		);
	});
});
