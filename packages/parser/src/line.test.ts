import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLine } from "./line.ts";
import type { InlineNode, LineRole, Span } from "./types.ts";

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
				kind: "text",
				indent: 0,
				nodes: [{ type: "text", start: 0, end: 5 }],
			});
		});

		it("空行はノードを持たない", () => {
			expect(parseLine("")).toEqual({ kind: "text", indent: 0, nodes: [] });
		});

		it("インデントは深さとして返し、ノードには含めない", () => {
			expect(parseLine(" \t本文")).toEqual({
				kind: "text",
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

		it("本文中のURLは、開き括弧の手前で終わる(直後の記法を巻き込まない)", () => {
			expect(parse("https://example.com[a]")).toEqual([
				expect.objectContaining({ type: "external-link", url: "https://example.com" }),
				expect.objectContaining({ type: "page-link", title: "a" }),
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

		it("コードの中の括弧は、外側の記法の括弧として数えない", () => {
			expect(parse("[* a`]`b]")).toEqual([
				expect.objectContaining({
					type: "decoration",
					raw: "[* a`]`b]",
					children: [text("a"), { type: "code", raw: "`]`", content: "]" }, text("b")],
				}),
			]);
			expect(parse("[[`[`]]")).toEqual([
				expect.objectContaining({
					type: "strong",
					children: [{ type: "code", raw: "`[`", content: "[" }],
				}),
			]);
		});

		it("バッククォートの対は括弧より優先する(行の左から順に対にする)", () => {
			expect(parse("[* a`b] c`")).toEqual([
				text("[* a"),
				{ type: "code", raw: "`b] c`", content: "b] c" },
			]);
		});

		it("タグやURLは、バッククォートの手前で終わる", () => {
			expect(parse("#a`b`")).toEqual([
				expect.objectContaining({ type: "hashtag", title: "a" }),
				{ type: "code", raw: "`b`", content: "b" },
			]);
			expect(parse("https://e.com/`b`")).toEqual([
				expect.objectContaining({ type: "external-link", url: "https://e.com/" }),
				{ type: "code", raw: "`b`", content: "b" },
			]);
		});

		it("空のバッククォートの対は飛ばし、その次から対を探す", () => {
			expect(parse("``a`")).toEqual([text("`"), { type: "code", raw: "`a`", content: "a" }]);
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
				kind: "text",
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

describe("parseLine: 行頭で決まる記法", () => {
	describe("コマンド行 $ コマンド", () => {
		it.each(["$ ls -la", "% ls -la"])(
			"%j は行全体がコマンドになり、中の記法は解釈しない",
			(raw) => {
				expect(parse(raw)).toEqual([{ type: "command-line", raw, content: raw }]);
			},
		);

		it("中の記法は解釈しない", () => {
			expect(parse("$ echo [a] #b")).toEqual([
				{ type: "command-line", raw: "$ echo [a] #b", content: "$ echo [a] #b" },
			]);
		});

		it("インデントのあとでもコマンドになる", () => {
			expect(parse(" $ ls")).toEqual([{ type: "command-line", raw: "$ ls", content: "$ ls" }]);
		});

		it.each(["$", "$ ", "$ls", "a $ ls"])("形の違う %j はコマンドにしない", (raw) => {
			expect(parse(raw)).toEqual([text(raw)]);
		});
	});

	describe("ヘルプ行 ? 文", () => {
		it("行全体がヘルプ行になる", () => {
			expect(parse("? 使い方 [a]")).toEqual([
				{ type: "helpfeel", raw: "? 使い方 [a]", content: "? 使い方 [a]" },
			]);
		});

		it.each(["?", "? ", "?a"])("形の違う %j はヘルプ行にしない", (raw) => {
			expect(parse(raw)).toEqual([text(raw)]);
		});
	});
});

describe("parseLine: 行の役割ごとの解析", () => {
	const role = (kind: LineRole["kind"], blockIndent = 0): LineRole => ({ kind, blockIndent });
	const slice = (raw: string, span: Span) => raw.slice(span.start, span.end);

	describe("タイトル行", () => {
		it("記法を解釈せず、全体を1つのテキストにする", () => {
			expect(parseLine("[a] #b", role("title"))).toEqual({
				kind: "title",
				indent: 0,
				nodes: [{ type: "text", start: 0, end: 6 }],
			});
		});

		it("空のタイトルはノードを持たない", () => {
			expect(parseLine("", role("title"))).toEqual({ kind: "title", indent: 0, nodes: [] });
		});
	});

	describe("ブロックの始まりの行", () => {
		it("code: と名前に分ける", () => {
			const raw = " code:hello.js";
			const parsed = parseLine(raw, role("code-head", 1));

			expect(parsed).toEqual({
				kind: "code-head",
				indent: 1,
				prefix: { start: 1, end: 6 },
				name: { start: 6, end: 14 },
			});
		});

		it("table: と名前に分ける", () => {
			const raw = "table:予定";
			const parsed = parseLine(raw, role("table-head"));

			expect(parsed.kind).toBe("table-head");
			if (parsed.kind !== "table-head") return;
			expect(slice(raw, parsed.prefix)).toBe("table:");
			expect(slice(raw, parsed.name)).toBe("予定");
		});

		it.each([
			["始まりの形をしていない行", "abc", "code-head"],
			["種類の違う始まりの行", "table:a", "code-head"],
			["種類の違う始まりの行", "code:a", "table-head"],
		] as const)("役割と行が食い違うとき(%s)は、本文として解析する", (_name, raw, kind) => {
			expect(parseLine(raw, role(kind)).kind).toBe("text");
		});
	});

	describe("コードブロックの中身", () => {
		it("始まりの行より1つ深いところまでがインデントで、残りはそのままコードになる", () => {
			const raw = "    if (a[0]) `x`";
			const parsed = parseLine(raw, role("code-body", 1));

			expect(parsed).toEqual({ kind: "code-body", indent: 2, content: { start: 2, end: 17 } });
			if (parsed.kind !== "code-body") return;
			expect(slice(raw, parsed.content)).toBe("  if (a[0]) `x`");
		});

		it("役割と行が食い違うとき(始まりの行より深くない)は、本文として解析する", () => {
			expect(parseLine(" [a]", role("code-body", 1)).kind).toBe("text");
		});
	});

	describe("テーブルの行", () => {
		const cells = (raw: string, blockIndent = 0) => {
			const parsed = parseLine(raw, role("table-row", blockIndent));
			if (parsed.kind !== "table-row") throw new Error(`not a table row: ${parsed.kind}`);
			return parsed.cells.map((cell) => ({
				content: slice(raw, cell.content),
				nodes: describeNodes(raw, cell.nodes),
			}));
		};

		it("インデントのあとを、タブでセルに分ける", () => {
			const raw = " a\tbc\td";

			expect(parseLine(raw, role("table-row"))).toEqual({
				kind: "table-row",
				indent: 1,
				cells: [
					{ content: { start: 1, end: 2 }, nodes: [{ type: "text", start: 1, end: 2 }] },
					{ content: { start: 3, end: 5 }, nodes: [{ type: "text", start: 3, end: 5 }] },
					{ content: { start: 6, end: 7 }, nodes: [{ type: "text", start: 6, end: 7 }] },
				],
			});
		});

		it("空のセルも1つのセルとして数える(行末のタブのあとも)", () => {
			expect(cells(" a\t\tb\t").map((cell) => cell.content)).toEqual(["a", "", "b", ""]);
		});

		it("中身のない行は、空のセルを1つ持つ", () => {
			expect(cells(" ")).toEqual([{ content: "", nodes: [] }]);
		});

		it("インデントは、始まりの行より1つ深いところまで。その直後のタブは、空の先頭セルを作る", () => {
			const raw = " \ta";

			const parsed = parseLine(raw, role("table-row"));

			expect(parsed).toEqual({
				kind: "table-row",
				indent: 1,
				cells: [
					{ content: { start: 1, end: 1 }, nodes: [] },
					{ content: { start: 2, end: 3 }, nodes: [{ type: "text", start: 2, end: 3 }] },
				],
			});
		});

		it("始まりの行がタブでインデントされていても、1つ深いところまでがインデントになる", () => {
			expect(cells("\t\ta\tb", 1).map((cell) => cell.content)).toEqual(["a", "b"]);
			expect(cells("\t\t\ta\tb", 1).map((cell) => cell.content)).toEqual(["", "a", "b"]);
		});

		it("インデントより後ろの空白は、先頭のセルの中身になる", () => {
			expect(cells("   a\tb").map((cell) => cell.content)).toEqual(["  a", "b"]);
		});

		it("セルの中では記法を解釈する", () => {
			expect(cells(" [a]\t`b` #c")).toEqual([
				{ content: "[a]", nodes: [expect.objectContaining({ type: "page-link", title: "a" })] },
				{
					content: "`b` #c",
					nodes: [
						expect.objectContaining({ type: "code", content: "b" }),
						text(" "),
						expect.objectContaining({ type: "hashtag", title: "c" }),
					],
				},
			]);
		});

		it("括弧やバッククォートは、セルをまたいで対にならない", () => {
			expect(cells(" [a\tb]\t`c\td`")).toEqual([
				{ content: "[a", nodes: [text("[a")] },
				{ content: "b]", nodes: [text("b]")] },
				{ content: "`c", nodes: [text("`c")] },
				{ content: "d`", nodes: [text("d`")] },
			]);
		});

		it("行頭の記法(引用やコマンド)は、セルの中では解釈しない", () => {
			expect(cells(" > a\t$ b")).toEqual([
				{ content: "> a", nodes: [text("> a")] },
				{ content: "$ b", nodes: [text("$ b")] },
			]);
		});

		it("役割と行が食い違うとき(始まりの行より深くない)は、本文として解析する", () => {
			expect(parseLine(" a\tb", role("table-row", 1)).kind).toBe("text");
		});
	});

	describe("性質", () => {
		const anyRole = fc.record({
			kind: fc.constantFrom<LineRole["kind"]>(
				"title",
				"text",
				"code-head",
				"code-body",
				"table-head",
				"table-row",
			),
			blockIndent: fc.integer({ min: 0, max: 3 }),
		});
		const rowText = fc.string({
			unit: fc.constantFrom(..."[]`#\t \t", "a", "あ", "code:", "table:", "https://e.com/"),
			maxLength: 30,
		});

		it("どんな行と役割の組み合わせでも例外を出さず、テーブルのセルは行を隙間なく覆う", () => {
			fc.assert(
				fc.property(rowText, anyRole, (raw, lineRole) => {
					const parsed = parseLine(raw, lineRole);
					if (parsed.kind !== "table-row") return;

					let position = parsed.indent;
					for (const cell of parsed.cells) {
						expect(cell.content.start).toBe(position);
						expectTiling(cell.nodes, cell.content);
						position = cell.content.end + 1; // セルの間のタブ
					}
					expect(position).toBe(raw.length + 1);
				}),
				{ numRuns: 1000 },
			);
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
