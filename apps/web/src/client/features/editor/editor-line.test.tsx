import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EditorLine } from "./editor-line.tsx";

afterEach(cleanup);

const line = () => screen.getByTestId("line");

/** 本文の行(タイトル行ではない行)を、カーソルのない状態で描画する。 */
function renderShown(text: string) {
	render(<EditorLine index={1} text={text} caretColumn={null} composing={null} />);
	return line();
}

/** 本文の行を、カーソルのある状態で描画する。 */
function renderEditing(text: string, caretColumn = 0, composing: string | null = null) {
	render(<EditorLine index={1} text={text} caretColumn={caretColumn} composing={composing} />);
	return line();
}

/** 行の中で、指定した要素より前にある文字列。 */
function textBefore(element: Element): string {
	const range = document.createRange();
	range.setStart(line(), 0);
	range.setEndBefore(element);
	return range.toString();
}

const columns = (root: Element) =>
	[...root.querySelectorAll("[data-column]")].map((el) => [
		el.textContent,
		Number(el.getAttribute("data-column")),
		Number(el.getAttribute("data-end")),
	]);

describe("EditorLine", () => {
	describe("文字とインデント", () => {
		it("本文を1文字ずつ、開始位置と終了位置を付けて描画する", () => {
			expect(columns(renderShown("a👍"))).toEqual([
				["a", 0, 1],
				["👍", 1, 3],
			]);
		});

		it("行頭の空白は文字として表示せず、インデントの深さとして描画する", () => {
			const element = renderShown(" \t箇条書き");

			expect(element.textContent).toBe("箇条書き");
			expect(element.getAttribute("data-indent")).toBe("2");
			expect(element.getAttribute("data-line")).toBe("1");
			expect(element.querySelectorAll(".indent")).toHaveLength(2);
		});

		it("箇条書きの印は、最後のインデントに1つだけ付く", () => {
			const indents = [...renderShown("  item").querySelectorAll(".indent")];

			expect(indents.map((i) => i.hasAttribute("data-bullet"))).toEqual([false, true]);
		});

		it("インデントのない行には印を付けない", () => {
			expect(renderShown("text").querySelector("[data-bullet]")).toBeNull();
		});
	});

	describe("カーソルと変換中の文字列", () => {
		it("カーソルのない行にはカーソルを描画しない", () => {
			renderShown("abc");

			expect(screen.queryByTestId("caret")).toBeNull();
		});

		it.each([
			[0, ""],
			[2, "ab"],
			[3, "abc"],
		])("カーソルを文字位置 %i に描画する", (caretColumn, before) => {
			renderEditing("abc", caretColumn);

			expect(textBefore(screen.getByTestId("caret"))).toBe(before);
		});

		it("カーソルはインデントの中にも置ける", () => {
			renderEditing("  item", 1);

			const caret = screen.getByTestId("caret");
			expect(caret.previousElementSibling?.getAttribute("data-column")).toBe("0");
			expect(caret.nextElementSibling?.getAttribute("data-column")).toBe("1");
		});

		it("カーソルは記法の中にも置ける", () => {
			renderEditing("a[* bc]", 5);

			expect(textBefore(screen.getByTestId("caret"))).toBe("a[* b");
		});

		it("変換中の文字列を、カーソルの直前に描画する", () => {
			renderEditing("ab", 1, "にほんご");

			const composing = screen.getByTestId("composing");
			expect(composing.textContent).toBe("にほんご");
			expect(textBefore(composing)).toBe("a");
			expect(composing.nextElementSibling).toBe(screen.getByTestId("caret"));
		});

		it("変換中でなければ、変換中の領域を描画しない", () => {
			renderEditing("ab", 1);

			expect(screen.queryByTestId("composing")).toBeNull();
		});
	});

	describe("カーソルのない行: 記法を隠して装飾する", () => {
		it("[タイトル] は括弧を隠し、ページへのリンクにする", () => {
			const element = renderShown("前[a b]後");

			const link = element.querySelector("a");
			expect(link?.textContent).toBe("a b");
			expect(link?.getAttribute("href")).toBe("./a_b");
			expect(link?.hasAttribute("target")).toBe(false);
			expect(element.textContent).toBe("前a b後");
		});

		it("隠した記法のぶん、文字の位置は生のテキストでの位置のままになる", () => {
			expect(columns(renderShown("[ab]c"))).toEqual([
				["a", 1, 2],
				["b", 2, 3],
				["c", 4, 5],
			]);
		});

		it("#タグ は # ごとリンクにする", () => {
			renderShown("#タグ");

			expect(screen.getByRole("link", { name: "#タグ" }).getAttribute("href")).toBe(
				"./%E3%82%BF%E3%82%B0",
			);
		});

		it("[/プロジェクト/ページ] は他のプロジェクトへのリンクにする", () => {
			renderShown("[/proj/page]");

			expect(screen.getByRole("link", { name: "/proj/page" }).getAttribute("href")).toBe(
				"/proj/page",
			);
		});

		it("外部リンクは表示文字だけを見せ、別のタブで開く", () => {
			const element = renderShown("[例 https://example.com/]");

			const link = screen.getByRole("link", { name: "例" });
			expect(link.getAttribute("href")).toBe("https://example.com/");
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toBe("noopener noreferrer");
			expect(element.textContent).toBe("例");
		});

		it("文字装飾は記号を隠し、記号の種類と太字の段階を属性に持たせる", () => {
			const element = renderShown("[**/ 文字]");

			const decoration = element.querySelector(".deco");
			expect(decoration?.textContent).toBe("文字");
			expect(decoration?.getAttribute("data-deco")).toBe("*/");
			expect(decoration?.getAttribute("style")).toContain("--deco-level: 2");
		});

		it("太字の段階には上限がある", () => {
			const decoration = renderShown(`[${"*".repeat(30)} x]`).querySelector(".deco");

			expect(decoration?.getAttribute("style")).toContain("--deco-level: 10");
		});

		it("装飾の中のリンクも表示する", () => {
			renderShown("[* [a]]");

			expect(screen.getByRole("link", { name: "a" }).closest(".deco")).not.toBeNull();
		});

		it("[[文字]] は強調にする", () => {
			expect(renderShown("[[強調]]").querySelector("strong")?.textContent).toBe("強調");
		});

		it("`コード` はコードとして表示し、バッククォートを隠す", () => {
			expect(renderShown("`a [b]`").querySelector("code.code")?.textContent).toBe("a [b]");
		});

		it("[$ 式] は数式として表示する", () => {
			expect(renderShown("[$ x^2]").querySelector("code.formula")?.textContent).toBe("x^2");
		});

		it("> で始まる行は引用として表示し、> を隠す", () => {
			const element = renderShown("> 引用");

			expect(element.querySelector(".quote")?.textContent).toBe(" 引用");
		});

		it("[画像URL] は画像を表示する。位置は記法全体の範囲を持つ", () => {
			const image = renderShown("a[https://example.com/a.png]").querySelector("img");

			expect(image?.getAttribute("src")).toBe("https://example.com/a.png");
			expect(image?.getAttribute("data-column")).toBe("1");
			expect(image?.getAttribute("data-end")).toBe("28");
			expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
			expect(image?.getAttribute("alt")).toBe("");
			expect(image?.closest("a")).toBeNull();
		});

		it("リンク付きの画像は、押すとリンク先を別のタブで開く", () => {
			const image = renderShown("[https://example.com/a.png https://example.com/]").querySelector(
				"img",
			);

			expect(image?.getAttribute("alt")).toBe("https://example.com/");
			expect(image?.closest("a")?.getAttribute("href")).toBe("https://example.com/");
			expect(image?.closest("a")?.getAttribute("target")).toBe("_blank");
		});

		it("[名前.icon] は名前の入った印を表示する(プロフィール画像はP4から)", () => {
			const icon = renderShown("[山田.icon]").querySelector(".icon");

			expect(icon?.textContent).toBe("山田");
			expect(icon?.getAttribute("data-column")).toBe("0");
			expect(icon?.getAttribute("data-end")).toBe("9");
		});

		it("[名前.icon*3] は数も表示する", () => {
			expect(renderShown("[山田.icon*3]").querySelector(".icon")?.textContent).toBe("山田×3");
		});
	});

	describe("カーソルのある行: 記法をそのまま見せる", () => {
		it.each([
			"前[a b]後 #タグ",
			"[例 https://example.com/] https://example.com/",
			"[**/ 文字] [[強調]] `code` [$ x]",
			"> 引用 [/proj/page]",
			"[https://example.com/a.png] [山田.icon*3]",
		])("%j は生のテキストがそのまま見える", (raw) => {
			expect(renderEditing(raw).textContent).toBe(raw);
		});

		it("リンクや画像は実体にしない(押したらカーソルを置けるようにする)", () => {
			const element = renderEditing("[a] [https://example.com/a.png] https://example.com/");

			expect(element.querySelector("a")).toBeNull();
			expect(element.querySelector("img")).toBeNull();
		});

		it("記法の記号には、本文と区別するための印を付ける", () => {
			const element = renderEditing("[* ab]");

			const notation = [...element.querySelectorAll(".notation")].map((el) => el.textContent);
			expect(notation.join("")).toBe("[* ]");
		});

		it("装飾の見た目は、記法を見せているあいだも保つ", () => {
			const element = renderEditing("[* ab] [x]");

			expect(element.querySelector(".deco")?.getAttribute("data-deco")).toBe("*");
			expect(element.querySelector(".link")?.textContent).toBe("[x]");
		});
	});

	describe("タイトル行(1行目)", () => {
		it("記法を解釈せず、書いたとおりに表示する", () => {
			render(<EditorLine index={0} text="[a] #b" caretColumn={null} composing={null} />);

			expect(line().textContent).toBe("[a] #b");
			expect(line().querySelector("a")).toBeNull();
			expect(line().classList.contains("title")).toBe(true);
		});

		it("2行目以降はタイトルの見た目にしない", () => {
			expect(renderShown("abc").classList.contains("title")).toBe(false);
		});
	});
});
