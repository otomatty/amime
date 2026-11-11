import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLine } from "./line.ts";
import type { InlineNode, Span } from "./types.ts";

/**
 * 解析結果を、位置の代わりに「その範囲の文字列」で表した形にする。
 * 位置が正しいことを、読みやすい形で検証するためのもの。
 */
function describeNodes(raw: string, nodes: readonly InlineNode[]): unknown[] {
	const slice = (span: Span) => raw.slice(span.start, span.end);
	return nodes.map((node) => {
		const { start: _start, end: _end, ...rest } = node;
		const described: Record<string, unknown> = { ...rest, raw: slice(node) };
		if ("content" in node) described["content"] = slice(node.content);
		if ("children" in node) described["children"] = describeNodes(raw, node.children);
		return described;
	});
}

const parse = (raw: string) => describeNodes(raw, parseLine(raw).nodes);
const text = (raw: string) => ({ type: "text", raw });

describe("parseLine", () => {
	describe("ただの文字列とインデント", () => {
		it("記法のない行は1つのテキストになる", () => {
			expect(parseLine("こんにちは")).toEqual({
				indent: 0,
				nodes: [{ type: "text", start: 0, end: 5 }],
			});
		});

		it("空行はノードを持たない", () => {
			expect(parseLine("")).toEqual({ indent: 0, nodes: [] });
		});

		it("インデントは深さとして返し、ノードには含めない", () => {
			expect(parseLine(" \t本文")).toEqual({
				indent: 2,
				nodes: [{ type: "text", start: 2, end: 4 }],
			});
		});
	});

	describe("ページリンク [タイトル]", () => {
		it("括弧の中身をタイトルとするリンクになる", () => {
			expect(parse("前[ページ タイトル]後")).toEqual([
				text("前"),
				{
					type: "page-link",
					raw: "[ページ タイトル]",
					content: "ページ タイトル",
					title: "ページ タイトル",
				},
				text("後"),
			]);
		});

		it("タイトルの前後の空白は取り除く(表示する範囲はそのまま)", () => {
			expect(parse("[ a ]")).toEqual([
				{ type: "page-link", raw: "[ a ]", content: " a ", title: "a" },
			]);
		});

		it.each(["[]", "[ ]", "[　]"])("中身が空の %j はリンクにしない", (raw) => {
			expect(parse(raw)).toEqual([text(raw)]);
		});

		it("閉じ括弧がなければリンクにしない", () => {
			expect(parse("[abc")).toEqual([text("[abc")]);
		});

		it("開き括弧のない閉じ括弧はただの文字", () => {
			expect(parse("a]b")).toEqual([text("a]b")]);
		});

		it("括弧が入れ子のとき、外側はリンクにせず内側だけをリンクにする", () => {
			expect(parse("[a [b] c]")).toEqual([
				text("[a "),
				{ type: "page-link", raw: "[b]", content: "b", title: "b" },
				text(" c]"),
			]);
		});

		it("1行に複数のリンクを書ける", () => {
			expect(parse("[a][b]").map((node) => (node as { type: string }).type)).toEqual([
				"page-link",
				"page-link",
			]);
		});
	});

	describe("ハッシュタグ #タグ", () => {
		it("# から空白の手前までがリンクになる(表示は # を含む)", () => {
			expect(parse("#タグ 続き")).toEqual([
				{ type: "hashtag", raw: "#タグ", content: "#タグ", title: "タグ" },
				text(" 続き"),
			]);
		});

		it("文中では、直前が空白のときだけタグになる", () => {
			expect(parse("a #b")).toEqual([
				text("a "),
				{ type: "hashtag", raw: "#b", content: "#b", title: "b" },
			]);
			expect(parse("a#b")).toEqual([text("a#b")]);
		});

		it("# だけではタグにならない", () => {
			expect(parse("# a")).toEqual([text("# a")]);
			expect(parse("#")).toEqual([text("#")]);
		});

		it("タグは括弧の手前で終わる", () => {
			expect(parse("#a[b]")).toEqual([
				{ type: "hashtag", raw: "#a", content: "#a", title: "a" },
				{ type: "page-link", raw: "[b]", content: "b", title: "b" },
			]);
		});
	});

	describe("外部プロジェクトへのリンク [/プロジェクト/ページ]", () => {
		it("プロジェクト名とページタイトルに分ける", () => {
			expect(parse("[/help-jp/文字装飾 記法]")).toEqual([
				{
					type: "project-link",
					raw: "[/help-jp/文字装飾 記法]",
					content: "/help-jp/文字装飾 記法",
					project: "help-jp",
					title: "文字装飾 記法",
				},
			]);
		});

		it.each(["[/help-jp]", "[/help-jp/]"])("%j はプロジェクトそのものへのリンク", (raw) => {
			expect(parse(raw)).toEqual([
				expect.objectContaining({ type: "project-link", project: "help-jp", title: null }),
			]);
		});

		it.each(["[/]", "[//a]"])("プロジェクト名のない %j は通常のページリンク", (raw) => {
			expect(parse(raw)).toEqual([expect.objectContaining({ type: "page-link" })]);
		});
	});

	describe("外部リンク", () => {
		const url = "https://example.com/a?b=1";

		it("本文中のURLは、そのままリンクになる", () => {
			expect(parse(`見て ${url} ね`)).toEqual([
				text("見て "),
				{ type: "external-link", raw: url, content: url, url },
				text(" ね"),
			]);
		});

		it("[URL] は、URLを表示するリンクになる", () => {
			expect(parse(`[${url}]`)).toEqual([
				{ type: "external-link", raw: `[${url}]`, content: url, url },
			]);
		});

		it("[URL 表示文字] は、表示文字だけを表示するリンクになる", () => {
			expect(parse(`[${url}  表示 文字]`)).toEqual([
				{ type: "external-link", raw: `[${url}  表示 文字]`, content: "表示 文字", url },
			]);
		});

		it("[表示文字 URL] も同じ", () => {
			expect(parse(`[表示 文字 ${url}]`)).toEqual([
				{ type: "external-link", raw: `[表示 文字 ${url}]`, content: "表示 文字", url },
			]);
		});

		it("[ URL] のように表示文字が空なら、URLを表示する", () => {
			expect(parse(`[ ${url}]`)).toEqual([
				{ type: "external-link", raw: `[ ${url}]`, content: url, url },
			]);
		});

		it("http も対象にする", () => {
			expect(parse("http://example.com")).toEqual([
				expect.objectContaining({ type: "external-link", url: "http://example.com" }),
			]);
		});

		it.each([
			"javascript:alert(1)",
			"data:text/html,x",
			"ftp://example.com",
			"https://",
			"http",
			"htt",
		])("http(s) で始まる完全なURLでない %j は外部リンクにしない", (raw) => {
			expect(parse(raw)).toEqual([text(raw)]);
			expect(parse(`[${raw}]`)).toEqual([expect.objectContaining({ type: "page-link" })]);
		});

		it("本文中のURLは、閉じ括弧の手前で終わる", () => {
			expect(parse("[* https://example.com]")).toEqual([
				expect.objectContaining({
					type: "decoration",
					children: [
						expect.objectContaining({ type: "external-link", raw: "https://example.com" }),
					],
				}),
			]);
		});
	});

	describe("画像 [画像URL]", () => {
		const image = "https://example.com/a.png";
		const link = "https://example.com/page";

		it.each(["png", "jpg", "jpeg", "gif", "svg", "webp", "PNG"])(
			"拡張子が %s のURLは画像になる",
			(extension) => {
				const src = `https://example.com/a.${extension}`;
				expect(parse(`[${src}]`)).toEqual([{ type: "image", raw: `[${src}]`, src, link: null }]);
			},
		);

		it("クエリ文字列が付いていても画像になる", () => {
			expect(parse(`[${image}?w=100]`)).toEqual([
				expect.objectContaining({ type: "image", src: `${image}?w=100` }),
			]);
		});

		it("[画像URL リンク先URL] は、リンク付きの画像になる", () => {
			expect(parse(`[${image} ${link}]`)).toEqual([
				{ type: "image", raw: `[${image} ${link}]`, src: image, link },
			]);
		});

		it("[リンク先URL 画像URL] も同じ", () => {
			expect(parse(`[${link} ${image}]`)).toEqual([
				{ type: "image", raw: `[${link} ${image}]`, src: image, link },
			]);
		});

		it("[画像URL 表示文字] は画像ではなく、画像へのリンクになる", () => {
			expect(parse(`[${image} 図1]`)).toEqual([
				{ type: "external-link", raw: `[${image} 図1]`, content: "図1", url: image },
			]);
		});

		it("括弧で囲んでいない画像URLは、ただのリンク", () => {
			expect(parse(image)).toEqual([expect.objectContaining({ type: "external-link" })]);
		});
	});

	describe("アイコン [名前.icon]", () => {
		it("名前を取り出す", () => {
			expect(parse("[山田 太郎.icon]")).toEqual([
				{ type: "icon", raw: "[山田 太郎.icon]", name: "山田 太郎", count: 1 },
			]);
		});

		it("*数 で並べる数を指定できる", () => {
			expect(parse("[a.icon*3]")).toEqual([expect.objectContaining({ name: "a", count: 3 })]);
		});

		it("他のプロジェクトのアイコンも書ける", () => {
			expect(parse("[/proj/a.icon]")).toEqual([
				expect.objectContaining({ type: "icon", name: "/proj/a" }),
			]);
		});

		it.each(["[.icon]", "[a.icon*0]", "[a.icon*x]"])("形式に合わない %j はページリンク", (raw) => {
			expect(parse(raw)).toEqual([expect.objectContaining({ type: "page-link" })]);
		});
	});

	describe("文字装飾 [記号 文字]", () => {
		it("[* 文字] は太字", () => {
			expect(parse("[* 太字]")).toEqual([
				{
					type: "decoration",
					raw: "[* 太字]",
					content: "太字",
					marks: "*",
					level: 1,
					children: [text("太字")],
				},
			]);
		});

		it("* の数が level になる", () => {
			expect(parse("[*** 大]")).toEqual([expect.objectContaining({ marks: "*", level: 3 })]);
		});

		it("記号は組み合わせられる(重複は1つにまとめる)", () => {
			expect(parse("[-**/_ 文字]")).toEqual([
				expect.objectContaining({ marks: "-*/_", level: 2, content: "文字" }),
			]);
		});

		it.each([..."!\"#%&'()*+,-./{|}<>_~"])("記号 %s を使える", (mark) => {
			expect(parse(`[${mark} x]`)).toEqual([
				expect.objectContaining({ type: "decoration", marks: mark, content: "x" }),
			]);
		});

		it("太字でなければ level は 0", () => {
			expect(parse("[/ 斜体]")).toEqual([expect.objectContaining({ marks: "/", level: 0 })]);
		});

		it("中に他の記法を書ける", () => {
			expect(parse("[* a [b] `c`]")).toEqual([
				expect.objectContaining({
					type: "decoration",
					children: [
						text("a "),
						expect.objectContaining({ type: "page-link", title: "b" }),
						text(" "),
						expect.objectContaining({ type: "code", content: "c" }),
					],
				}),
			]);
		});

		it("記号のあとに空白がなければ装飾にしない", () => {
			expect(parse("[*太字]")).toEqual([expect.objectContaining({ type: "page-link" })]);
		});

		it("記号のあとに文字がなければ装飾にしない", () => {
			expect(parse("[* ]")).toEqual([expect.objectContaining({ type: "page-link", title: "*" })]);
		});

		it("使えない記号は装飾にしない", () => {
			expect(parse("[= x]")).toEqual([expect.objectContaining({ type: "page-link" })]);
		});
	});

	describe("強調 [[文字]]", () => {
		it("二重の括弧は強調になる", () => {
			expect(parse("[[強調]]")).toEqual([
				{ type: "strong", raw: "[[強調]]", content: "強調", children: [text("強調")] },
			]);
		});

		it("中に他の記法を書ける", () => {
			expect(parse("[[a [b]]]")).toEqual([
				expect.objectContaining({
					type: "strong",
					content: "a [b]",
					children: [text("a "), expect.objectContaining({ type: "page-link" })],
				}),
			]);
		});

		it.each(["[[]]", "[[ ]]"])("中身が空の %j は強調にしない", (raw) => {
			expect(parse(raw).some((node) => (node as { type: string }).type === "strong")).toBe(false);
		});

		it("[[a] b] のように内側の括弧が先に閉じるものは強調ではない", () => {
			expect(parse("[[a] b]")).toEqual([
				text("["),
				expect.objectContaining({ type: "page-link", title: "a" }),
				text(" b]"),
			]);
		});
	});

	describe("インラインコード `コード`", () => {
		it("バッククォートで囲んだ範囲はコードになり、中の記法は解釈しない", () => {
			expect(parse("a `[b] #c` d")).toEqual([
				text("a "),
				{ type: "code", raw: "`[b] #c`", content: "[b] #c" },
				text(" d"),
			]);
		});

		it.each(["`abc", "``", "a`"])("閉じていない・中身が空の %j はコードにしない", (raw) => {
			expect(parse(raw)).toEqual([text(raw)]);
		});

		it("装飾の中のコードは、装飾の外にあるバッククォートとは対にならない", () => {
			expect(parse("[* a`b] c`")).toEqual([
				expect.objectContaining({ type: "decoration", children: [text("a`b")] }),
				text(" c`"),
			]);
		});
	});

	describe("数式 [$ 式]", () => {
		it("$ と空白のあとが数式になる", () => {
			expect(parse("[$ E = mc^2]")).toEqual([
				{ type: "formula", raw: "[$ E = mc^2]", content: "E = mc^2" },
			]);
		});

		it("式の中の括弧は、対になっていれば使える", () => {
			expect(parse("[$ a[1]]")).toEqual([
				expect.objectContaining({ type: "formula", content: "a[1]" }),
			]);
		});

		it("式が空なら数式にしない", () => {
			expect(parse("[$ ]")).toEqual([expect.objectContaining({ type: "page-link" })]);
		});
	});

	describe("引用 > 文", () => {
		it("行頭の > 以降が引用になる", () => {
			expect(parse("> 引用 [a]")).toEqual([
				{
					type: "quote",
					raw: "> 引用 [a]",
					content: " 引用 [a]",
					children: [text(" 引用 "), expect.objectContaining({ type: "page-link" })],
				},
			]);
		});

		it("インデントのあとでも引用になる", () => {
			expect(parseLine(" >a")).toEqual({
				indent: 1,
				nodes: [
					{
						type: "quote",
						start: 1,
						end: 3,
						content: { start: 2, end: 3 },
						children: [{ type: "text", start: 2, end: 3 }],
					},
				],
			});
		});

		it("> だけの行は、中身のない引用", () => {
			expect(parse(">")).toEqual([{ type: "quote", raw: ">", content: "", children: [] }]);
		});

		it("行の途中の > は引用にしない", () => {
			expect(parse("a > b")).toEqual([text("a > b")]);
		});
	});

	describe("深い入れ子", () => {
		it("入れ子が深すぎる部分は、それ以上解釈せずただの文字列として扱う", () => {
			const depth = 200;
			const raw = `${"[* ".repeat(depth)}x${"]".repeat(depth)}`;

			let nodes = parseLine(raw).nodes;
			let levels = 0;
			while (nodes[0]?.type === "decoration") {
				nodes = nodes[0].children;
				levels += 1;
			}

			expect(levels).toBeGreaterThan(0);
			expect(levels).toBeLessThan(depth);
			expect(nodes).toEqual([expect.objectContaining({ type: "text" })]);
		});

		it("極端に深い入れ子でも例外を出さない", () => {
			const raw = `${"[* ".repeat(20_000)}x${"]".repeat(20_000)}`;
			expect(() => parseLine(raw)).not.toThrow();
		});
	});
});

/** 記法の記号が高い頻度で現れる文字列。 */
const notationHeavy = fc.string({
	unit: fc.constantFrom(
		..."[]`#>$*/-_!. \t",
		"a",
		"b",
		"あ",
		"👍",
		"https://e.com/",
		"http://",
		".png",
		".icon",
		"icon*2",
	),
	maxLength: 40,
});

/** ノードの列が range を隙間も重なりもなく覆っていることを確かめ、子も再帰的に確かめる。 */
function expectTiling(nodes: readonly InlineNode[], range: Span): void {
	let position = range.start;
	for (const node of nodes) {
		expect(node.start).toBe(position);
		expect(node.end).toBeGreaterThan(node.start);
		if ("content" in node) {
			expect(node.content.start).toBeGreaterThanOrEqual(node.start);
			expect(node.content.end).toBeLessThanOrEqual(node.end);
			expect(node.content.end).toBeGreaterThanOrEqual(node.content.start);
		}
		if ("children" in node) expectTiling(node.children, node.content);
		position = node.end;
	}
	expect(position).toBe(range.end);
}

describe("parseLine の性質", () => {
	it.each([
		["記法の記号が多い文字列", notationHeavy],
		["任意の文字列", fc.string({ unit: "grapheme" })],
	])("%s: 例外を出さず、ノードはインデントより後ろを隙間なく覆う", (_name, arbitrary) => {
		fc.assert(
			fc.property(arbitrary, (raw) => {
				const { indent, nodes } = parseLine(raw);
				expectTiling(nodes, { start: indent, end: raw.length });
			}),
			{ numRuns: 500 },
		);
	});

	it("テキストのノードが隣り合うことはない(まとめて1つになる)", () => {
		fc.assert(
			fc.property(notationHeavy, (raw) => {
				const { nodes } = parseLine(raw);
				nodes.forEach((node, index) => {
					if (index > 0 && node.type === "text") expect(nodes[index - 1]?.type).not.toBe("text");
				});
			}),
		);
	});

	it("外部リンクと画像のURLは、必ず http:// か https:// で始まる", () => {
		const urlsOf = (node: InlineNode): (string | null)[] => {
			if (node.type === "external-link") return [node.url];
			if (node.type === "image") return [node.src, node.link];
			return "children" in node ? node.children.flatMap(urlsOf) : [];
		};

		fc.assert(
			fc.property(notationHeavy, (raw) => {
				const urls = parseLine(raw)
					.nodes.flatMap(urlsOf)
					.filter((url) => url !== null);
				for (const url of urls) expect(url).toMatch(/^https?:\/\/\S/);
			}),
			{ numRuns: 500 },
		);
	});
});
