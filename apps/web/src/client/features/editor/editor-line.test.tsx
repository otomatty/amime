import type { LineKind } from "@amime/parser";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EditorLine, type RemoteCaret } from "./editor-line.tsx";
import { IconSourceProvider } from "./icons.tsx";

afterEach(cleanup);

const line = () => screen.getByTestId("line");

type Role = { readonly kind: LineKind; readonly blockIndent: number };
const TEXT: Role = { kind: "text", blockIndent: 0 };

function renderLine(
	text: string,
	role: Role,
	caretColumn: number | null,
	composing: string | null,
) {
	render(
		<EditorLine
			index={1}
			text={text}
			kind={role.kind}
			blockIndent={role.blockIndent}
			caretColumn={caretColumn}
			composing={composing}
		/>,
	);
	return line();
}

/** カーソルのない状態で描画する。役割を省略すると本文の行。 */
const renderShown = (text: string, role: Role = TEXT) => renderLine(text, role, null, null);

/** カーソルのある状態で描画する。 */
const renderEditing = (
	text: string,
	caretColumn = 0,
	composing: string | null = null,
	role = TEXT,
) => renderLine(text, role, caretColumn, composing);

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

	describe("記法の境界をまたいで結合する文字", () => {
		const ACUTE = "\u0301"; // 直前の文字に重なるアクセント記号

		it("閉じ括弧の直後の結合文字は、括弧を隠しても表示する", () => {
			expect(renderShown(`[a]${ACUTE}`).textContent).toBe(`a${ACUTE}`);
		});

		it("開き括弧の直後の結合文字は、括弧を隠しても表示する", () => {
			expect(renderShown(`[${ACUTE}a]`).textContent).toBe(`${ACUTE}a`);
		});

		it("インデントの直後の結合文字も表示する", () => {
			const element = renderShown(` ${ACUTE}a`);

			expect(element.textContent).toBe(`${ACUTE}a`);
			expect(element.querySelectorAll(".indent")).toHaveLength(1);
		});

		it("編集中は、結合文字の手前の記号の前にカーソルを描画できる", () => {
			// 「]」と結合文字は1文字として扱われるので、カーソルの位置は「]」の前(2)になる。
			renderEditing(`[a]${ACUTE}`, 2);

			expect(textBefore(screen.getByTestId("caret"))).toBe("[a");
		});
	});

	describe("壊れた文字", () => {
		it.each([
			["装飾して表示する行", null],
			["編集中の行", 0],
		])(
			"対になっていないサロゲートを含むリンクがあっても、%sの描画を続ける",
			(_name, caretColumn) => {
				const text = "[\uD800] [/\uD800/a]";

				expect(renderLine(text, TEXT, caretColumn, null).getAttribute("data-text")).toBe(text);
			},
		);
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

	describe("他の人のカーソル(ADR-0023)", () => {
		const TABLE_ROW: Role = { kind: "table-row", blockIndent: 0 };
		const other = (column: number, key = "bob", color = 3) => ({ key, column, color });
		/** 他の人のカーソルを付けて描画する。caretColumn を渡すと、自分のカーソルもある行にする。 */
		function renderWith(
			text: string,
			others: readonly RemoteCaret[],
			caretColumn: number | null = null,
			role: Role = TEXT,
		) {
			render(
				<EditorLine
					index={1}
					text={text}
					kind={role.kind}
					blockIndent={role.blockIndent}
					caretColumn={caretColumn}
					composing={null}
					others={others}
				/>,
			);
			return screen.getAllByTestId("remote-caret");
		}

		it("表示名のあるカーソルには、名前の札を添える。名前のないカーソルには、添えない", () => {
			const [named, plain] = renderWith("abc", [
				{ ...other(1), name: "山田 花子" },
				{ ...other(2), key: "nameless" },
			]);

			expect(named?.querySelector(".remote-caret-name")?.textContent).toBe("山田 花子");
			expect(named?.getAttribute("data-color")).toBe(String(other(1).color));
			expect(plain?.querySelector(".remote-caret-name")).toBeNull();
			// 札は、行の本文には数えない(文字の位置を、ずらさない)。
			expect(named?.querySelector(".remote-caret-name")?.getAttribute("data-column")).toBeNull();
		});

		it("他の人のカーソルがなければ、描画しない", () => {
			renderShown("abc");

			expect(screen.queryByTestId("remote-caret")).toBeNull();
		});

		it.each([
			[0, ""],
			[1, "a"],
			[3, "abc"],
		])("文字位置 %i に描画する", (column, before) => {
			const [caret] = renderWith("abc", [other(column)]);

			expect(caret && textBefore(caret)).toBe(before);
		});

		it("人ごとの色の番号を持つ。画面を読み上げる道具には伝えない", () => {
			const [caret] = renderWith("abc", [other(1, "bob", 5)]);

			expect(caret?.getAttribute("data-color")).toBe("5");
			expect(caret?.getAttribute("aria-hidden")).toBe("true");
		});

		it("行の本文より後ろの位置は、行末に描画する(相手の本文が、まだ届いていない)", () => {
			const [caret] = renderWith("abc", [other(10)]);

			expect(caret && textBefore(caret)).toBe("abc");
			expect(caret?.nextElementSibling).toBeNull();
		});

		it("文字の途中の位置は、その文字の前に描画する", () => {
			const [caret] = renderWith("a😀b", [other(2)]);

			expect(caret && textBefore(caret)).toBe("a");
		});

		it("同じ位置に何人いても、全員の分を描画する。自分のカーソルも描画する", () => {
			const carets = renderWith("abc", [other(1, "bob"), other(1, "carol")], 1);

			expect(carets).toHaveLength(2);
			expect(textBefore(screen.getByTestId("caret"))).toBe("a");
		});

		it("インデントの中にも描画する", () => {
			const [caret] = renderWith("  item", [other(1)]);

			expect(caret?.previousElementSibling?.getAttribute("data-column")).toBe("0");
			expect(caret?.nextElementSibling?.getAttribute("data-column")).toBe("1");
		});

		it("隠している記法の中の位置は、その記法のあった場所に描画する", () => {
			// 「[」は隠れている。「a」と「b」のあいだに描画する。
			const [opening] = renderWith("a[b]c", [other(1)]);
			expect(opening && textBefore(opening)).toBe("a");
			cleanup();

			// 「]」も隠れている。「b」と「c」のあいだに描画する。
			const [closing] = renderWith("a[b]c", [other(3)]);
			expect(closing && textBefore(closing)).toBe("ab");
		});

		it("記法を見せている行(自分のカーソルのある行)では、記法の中の位置にそのまま描画する", () => {
			const [caret] = renderWith("a[b]c", [other(2)], 0);

			expect(caret && textBefore(caret)).toBe("a[");
		});

		it("画像やアイコンの記法の中の位置は、その画像やアイコンの前に描画する", () => {
			const [onImage] = renderWith("a[https://example.com/b.png]", [other(5)]);
			expect(onImage?.nextElementSibling?.tagName).toBe("IMG");
			cleanup();

			const [onIcon] = renderWith("a[bob.icon]", [other(3)]);
			expect(onIcon?.nextElementSibling?.className).toContain("icon");
		});

		it("テーブルの行では、セルの中と、セルの区切りの位置に描画する", () => {
			// " a\tbc": 位置 2 は「a」のあと(区切りのタブの前)、位置 4 は「b」と「c」のあいだ。
			const [afterA, insideBc] = renderWith(
				" a\tbc",
				[other(2, "bob"), other(4, "carol")],
				null,
				TABLE_ROW,
			);

			expect(afterA?.closest(".cell-text")?.textContent).toBe("a");
			expect(insideBc?.closest(".cell-text")?.textContent).toBe("bc");
			expect(insideBc?.previousElementSibling?.textContent).toBe("b");
		});

		it("テーブルの行の末尾より後ろの位置は、最後のセルの末尾に描画する", () => {
			const [caret] = renderWith(" a\tbc", [other(9)], null, TABLE_ROW);

			expect(caret?.closest(".cell-text")?.textContent).toBe("bc");
			expect(caret?.previousElementSibling?.textContent).toBe("c");
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

		describe("まだないページへのリンク(ADR-0027)", () => {
			const renderWithMissing = (text: string, caretColumn: number | null = null) => {
				render(
					<EditorLine
						index={1}
						text={text}
						kind="text"
						blockIndent={0}
						caretColumn={caretColumn}
						composing={null}
						missingLinks={new Set(["まだない_page"])}
					/>,
				);
				return line();
			};

			it("まだないページへのリンクには、印を付ける。名前は、大文字小文字と空白の違いを区別せずに照らし合わせる", () => {
				const element = renderWithMissing("[まだない Page] と [ある ページ] と #まだない_page");

				const [missing, existing, tag] = element.querySelectorAll("a");
				expect(missing?.getAttribute("data-missing")).toBe("true");
				expect(existing?.hasAttribute("data-missing")).toBe(false);
				expect(tag?.getAttribute("data-missing")).toBe("true");
				// 開けば、その名前で書き始められる。リンク先は変わらない。
				expect(missing?.getAttribute("href")).toBe("./%E3%81%BE%E3%81%A0%E3%81%AA%E3%81%84_Page");
			});

			it("編集中の行でも、印を付ける", () => {
				const element = renderWithMissing("[まだない page]", 0);

				expect(element.querySelector(".link")?.getAttribute("data-missing")).toBe("true");
			});

			it("他のプロジェクトへのリンクや、外部へのリンクには、印を付けない", () => {
				const element = renderWithMissing(
					"[/まだない_page/まだない_page] [https://example.com まだない_page]",
				);

				for (const link of element.querySelectorAll("a")) {
					expect(link.hasAttribute("data-missing")).toBe(false);
				}
			});
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

		it("[名前.icon] は、画像を引けたら、画像を表示する", async () => {
			const { container } = render(
				<IconSourceProvider source={async () => "https://images.example/yamada.png"}>
					<EditorLine
						index={1}
						text="[山田.icon]"
						kind="text"
						blockIndent={0}
						caretColumn={null}
						composing={null}
					/>
				</IconSourceProvider>,
			);

			const image = await screen.findByRole("img", { name: "山田" });
			expect(image.getAttribute("src")).toBe("https://images.example/yamada.png");
			// 画像になっても、行の中の位置(押したときにカーソルが入る位置)は変わらない。
			expect(container.querySelector(".icon")?.getAttribute("data-column")).toBe("0");
		});

		it("[名前.icon] は、画像を引けなければ、名前の入った印を表示する", () => {
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

	describe("範囲選択", () => {
		function renderSelected(
			text: string,
			selection: { start: number; end: number; lineBreak?: boolean },
			caretColumn: number | null = null,
		) {
			render(
				<EditorLine
					index={1}
					text={text}
					kind="text"
					blockIndent={0}
					caretColumn={caretColumn}
					composing={null}
					selectionStart={selection.start}
					selectionEnd={selection.end}
					selectsLineBreak={selection.lineBreak ?? false}
				/>,
			);
			return line();
		}
		const selected = (element: Element) =>
			[...element.querySelectorAll("[data-column].selected")].map((el) => el.textContent).join("");

		it("選択していない行には、選択の印を付けない", () => {
			expect(renderShown("abc").querySelector(".selected")).toBeNull();
		});

		it("選択した範囲の文字に印を付ける", () => {
			expect(selected(renderSelected("abcd", { start: 1, end: 3 }))).toBe("bc");
		});

		it("インデントも選択の対象になる", () => {
			const element = renderSelected(" ab", { start: 0, end: 2 });

			expect(element.querySelectorAll(".indent.selected")).toHaveLength(1);
			expect(selected(element)).toBe("a");
		});

		it("編集中の行では、記法の記号にも印を付ける", () => {
			expect(selected(renderSelected("[ab]c", { start: 0, end: 4 }, 4))).toBe("[ab]");
		});

		it("装飾して表示している行では、見えている文字にだけ印が付く", () => {
			expect(selected(renderSelected("[ab]c", { start: 0, end: 4 }))).toBe("ab");
		});

		it("画像は、記法全体が選択の中にあるときに印を付ける", () => {
			const raw = "[https://example.com/a.png]";

			expect(
				renderSelected(raw, { start: 0, end: raw.length }).querySelector("img.selected"),
			).not.toBeNull();
			cleanup();
			expect(renderSelected(raw, { start: 0, end: 5 }).querySelector("img.selected")).toBeNull();
		});

		it("選択が次の行へ続くときは、行末に改行の印を表示する", () => {
			const element = renderSelected("ab", { start: 1, end: 2, lineBreak: true });

			expect(element.querySelector(".line-break.selected")).not.toBeNull();
		});

		it("選択がこの行で終わるときは、改行の印を表示しない", () => {
			expect(renderSelected("ab", { start: 1, end: 2 }).querySelector(".line-break")).toBeNull();
		});

		it("テーブルの行では、改行の印を最後のセルの中に表示する", () => {
			render(
				<EditorLine
					index={2}
					text={" a\tb"}
					kind="table-row"
					blockIndent={0}
					caretColumn={null}
					composing={null}
					selectionStart={4}
					selectionEnd={4}
					selectsLineBreak
				/>,
			);

			const cells = line().querySelectorAll(".cell-text");
			expect(cells[1]?.querySelector(".line-break.selected")).not.toBeNull();
			expect(line().querySelectorAll(".line-break")).toHaveLength(1);
		});

		it("空行でも、選択が次の行へ続くなら改行の印を表示する", () => {
			expect(
				renderSelected("", { start: 0, end: 0, lineBreak: true }).querySelector(".line-break"),
			).not.toBeNull();
		});
	});

	describe("タイトル行", () => {
		const TITLE: Role = { kind: "title", blockIndent: 0 };

		it("記法を解釈せず、書いたとおりに表示する", () => {
			const element = renderShown("[a] #b", TITLE);

			expect(element.textContent).toBe("[a] #b");
			expect(element.querySelector("a")).toBeNull();
			expect(element.getAttribute("data-kind")).toBe("title");
		});

		it("本文の行はタイトルの見た目にしない", () => {
			expect(renderShown("abc").getAttribute("data-kind")).toBe("text");
		});
	});

	describe("コマンド行とヘルプ行", () => {
		it("$ で始まる行は、記号ごとコマンドとして表示し、中の記法は解釈しない", () => {
			const element = renderShown("$ echo [a]");

			expect(element.querySelector("code.command-line")?.textContent).toBe("$ echo [a]");
			expect(element.querySelector("a")).toBeNull();
		});

		it("? で始まる行は、ヘルプ行として表示する", () => {
			expect(renderShown("? 使い方").querySelector("code.helpfeel")?.textContent).toBe("? 使い方");
		});
	});

	describe("コードブロック", () => {
		const HEAD: Role = { kind: "code-head", blockIndent: 0 };
		const BODY: Role = { kind: "code-body", blockIndent: 0 };

		it("始まりの行は、code: を隠して名前を見出しとして表示する", () => {
			const element = renderShown("code:hello.js", HEAD);

			expect(element.querySelector(".block-label")?.textContent).toBe("hello.js");
			expect(element.getAttribute("data-kind")).toBe("code-head");
		});

		it("始まりの行を編集中は、code: も見せる", () => {
			const element = renderEditing("code:hello.js", 0, null, HEAD);

			expect(element.textContent).toBe("code:hello.js");
			expect([...element.querySelectorAll(".notation")].map((el) => el.textContent).join("")).toBe(
				"code:",
			);
		});

		it("中身の行は記法を解釈せず、書いたとおりに表示する", () => {
			const element = renderShown(" const a = [b]; `c` #d", BODY);

			expect(element.querySelector(".code-text")?.textContent).toBe("const a = [b]; `c` #d");
			expect(element.querySelector("a")).toBeNull();
			expect(element.querySelector("code")).toBeNull();
			expect(element.getAttribute("data-kind")).toBe("code-body");
		});

		it("中身の行のインデントは1段ぶんだけで、それより後ろの空白はコードの字下げとして残す", () => {
			const element = renderShown("   x", BODY);

			expect(element.getAttribute("data-indent")).toBe("1");
			expect(element.querySelectorAll(".indent")).toHaveLength(1);
			expect(element.querySelector(".code-text")?.textContent).toBe("  x");
		});

		it("中身の行には箇条書きの印を付けない", () => {
			expect(renderShown(" x", BODY).querySelector("[data-bullet]")).toBeNull();
		});

		it("中身の行でも、カーソルは行末に描画できる", () => {
			renderEditing(" ab", 3, null, BODY);

			expect(textBefore(screen.getByTestId("caret"))).toBe("ab");
		});
	});

	describe("テーブル", () => {
		const HEAD: Role = { kind: "table-head", blockIndent: 0 };
		const ROW: Role = { kind: "table-row", blockIndent: 0 };
		const cellTexts = (element: Element) =>
			[...element.querySelectorAll(".cell-text")].map((cell) => cell.textContent);

		it("始まりの行は、table: を隠して名前を見出しとして表示する", () => {
			expect(renderShown("table:予定", HEAD).querySelector(".block-label")?.textContent).toBe(
				"予定",
			);
		});

		it("行は、タブで区切ったセルとして表示する", () => {
			const element = renderShown(" a\tbc\t", ROW);

			expect(cellTexts(element)).toEqual(["a", "bc", ""]);
			expect(element.getAttribute("data-kind")).toBe("table-row");
		});

		it("インデントはセルとは別の枠に入れ、箇条書きの印を付けない", () => {
			const element = renderShown("  a", { kind: "table-row", blockIndent: 1 });

			expect(element.querySelectorAll(".indent-cell .indent")).toHaveLength(2);
			expect(element.querySelector("[data-bullet]")).toBeNull();
		});

		it("セルの中では記法を解釈する", () => {
			renderShown(" [a]\tb", ROW);

			expect(screen.getByRole("link", { name: "a" }).closest(".cell-text")).not.toBeNull();
		});

		it("セルの余白は、そのセルの末尾の位置を持つ(余白を押すとセルの末尾にカーソルが入る)", () => {
			const fills = [...renderShown(" a\tbc\t", ROW).querySelectorAll(".cell-fill")];

			expect(fills.map((fill) => fill.getAttribute("data-column"))).toEqual(["2", "5", "6"]);
			expect(fills.map((fill) => fill.getAttribute("data-end"))).toEqual(["2", "5", "6"]);
		});

		it.each([
			["セルの末尾(タブの手前)", 2, 0, "a"],
			["次のセルの先頭(タブの後ろ)", 3, 1, ""],
			["セルの途中", 4, 1, "b"],
			["空のセル", 6, 2, ""],
		])("カーソルを%sに描画する", (_name, caretColumn, cellIndex, before) => {
			const element = renderEditing(" a\tbc\t", caretColumn, null, ROW);

			const carets = element.querySelectorAll("[data-testid='caret']");
			expect(carets).toHaveLength(1);
			const cell = element.querySelectorAll(".cell-text")[cellIndex];
			expect(cell?.contains(carets[0] ?? null)).toBe(true);
			const range = document.createRange();
			range.setStart(cell as Element, 0);
			range.setEndBefore(carets[0] as Element);
			expect(range.toString()).toBe(before);
		});

		it("インデントの直後のタブは、空の先頭セルになる", () => {
			expect(cellTexts(renderShown(" \ta", ROW))).toEqual(["", "a"]);
		});

		it("セルは、生のテキストでの範囲を属性に持つ(余白を押したときの位置決めに使う)", () => {
			const cells = [...renderShown(" [a]\tb", ROW).querySelectorAll(".cell:not(.indent-cell)")];

			expect(cells.map((cell) => cell.getAttribute("data-cell-start"))).toEqual(["1", "5"]);
			expect(cells.map((cell) => cell.getAttribute("data-cell-end"))).toEqual(["4", "6"]);
		});

		it("カーソルはインデントの中にも描画できる", () => {
			const element = renderEditing("  a", 1, null, { kind: "table-row", blockIndent: 1 });

			expect(element.querySelector(".indent-cell [data-testid='caret']")).not.toBeNull();
		});
	});
});
