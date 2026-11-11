import { parseIndent } from "./indent.ts";
import type { ImageNode, InlineNode, ParsedLine, Span } from "./types.ts";

/**
 * 記法の入れ子を解釈する深さの上限。これより深い部分は、ただの文字列として扱う。
 * 悪意のある入力で再帰が深くなりすぎるのを防ぐ。実際の文章では3段を超えることはまずない。
 */
const MAX_DEPTH = 8;

const OPEN_BRACKET = "[".charCodeAt(0);
const CLOSE_BRACKET = "]".charCodeAt(0);

const WHITESPACE = /\s/;
/** [$ 式] の先頭。式が空でないことも確かめる。 */
const FORMULA_HEAD = /\$ (?=\s*[^\s\]])/y;
/** [記号 文字] の先頭。記号の種類は公開ヘルプ「文字装飾記法」に挙げられているもの。 */
const DECORATION_HEAD = /[!"#%&'()*+,\-./{|}<>_~]+ +(?=[^\s\]])/y;
const HASHTAG = /#[^\s[\]]+/y;
const BARE_URL = /https?:\/\/[^\s\]]+/y;
const ICON_SUFFIX = /\.icon(?:\*[1-9]\d*)?$/;
const URL_FIRST = /^https?:\/\/\S+/;
const URL_LAST = /\shttps?:\/\/\S+$/;
const WHOLE_URL = /^https?:\/\/\S+$/;
const IMAGE_URL = /\.(?:png|jpe?g|gif|svg|webp)(?:\?\S*)?$/i;
const PROJECT_LINK = /^\/[^\s/]+(?:\/.*)?$/;

type Context = {
	readonly raw: string;
	/** 開き括弧の位置 → 対になる閉じ括弧の位置。対のない括弧は含まない。 */
	readonly closing: ReadonlyMap<number, number>;
};

/** 括弧の対応を、行全体について一度だけ求める。 */
function findClosingBrackets(raw: string): Map<number, number> {
	const closing = new Map<number, number>();
	const unclosed: number[] = [];
	for (let position = 0; position < raw.length; position += 1) {
		const code = raw.charCodeAt(position);
		if (code === OPEN_BRACKET) {
			unclosed.push(position);
		} else if (code === CLOSE_BRACKET) {
			const open = unclosed.pop();
			if (open !== undefined) closing.set(open, position);
		}
	}
	return closing;
}

/** position から始まる位置でだけ、パターンを照合する(文字列を切り出さずに済む)。 */
function matchAt(pattern: RegExp, raw: string, position: number): string | undefined {
	pattern.lastIndex = position;
	return pattern.exec(raw)?.[0];
}

function code(ctx: Context, open: number, end: number): InlineNode | null {
	const close = ctx.raw.indexOf("`", open + 1);
	if (close === -1 || close >= end || close === open + 1) return null;
	return { type: "code", start: open, end: close + 1, content: { start: open + 1, end: close } };
}

function hashtag(ctx: Context, start: number): InlineNode | null {
	// 文中の # は、直前が空白のときだけタグの始まりとみなす(「C#」などを巻き込まない)。
	const before = ctx.raw.charAt(start - 1);
	if (before !== "" && !WHITESPACE.test(before)) return null;
	const matched = matchAt(HASHTAG, ctx.raw, start);
	if (matched === undefined) return null;
	const end = start + matched.length;
	return { type: "hashtag", start, end, content: { start, end }, title: matched.slice(1) };
}

function bareUrl(ctx: Context, start: number): InlineNode | null {
	const url = matchAt(BARE_URL, ctx.raw, start);
	if (url === undefined) return null;
	const end = start + url.length;
	return { type: "external-link", start, end, content: { start, end }, url };
}

/** 入れ子の中身を解析する。深さの上限に達していたら、中身全体をただの文字列にする。 */
function parseChildren(ctx: Context, content: Span, depth: number): InlineNode[] {
	if (depth >= MAX_DEPTH) return [{ type: "text", ...content }];
	return parseRange(ctx, content, depth + 1);
}

/** 中に他の記法を書ける括弧([[強調]]、[$ 数式]、[記号 装飾])を解析する。 */
function container(ctx: Context, node: Span, depth: number): InlineNode | null {
	const { raw } = ctx;
	const innerStart = node.start + 1;
	const close = node.end - 1;

	if (ctx.closing.get(innerStart) === close - 1) {
		const content = { start: innerStart + 1, end: close - 1 };
		if (raw.slice(content.start, content.end).trim() === "") return null;
		return { type: "strong", ...node, content, children: parseChildren(ctx, content, depth) };
	}

	const formulaHead = matchAt(FORMULA_HEAD, raw, innerStart);
	if (formulaHead !== undefined) {
		const content = { start: innerStart + formulaHead.length, end: close };
		return { type: "formula", ...node, content };
	}

	const decorationHead = matchAt(DECORATION_HEAD, raw, innerStart);
	if (decorationHead !== undefined) {
		const content = { start: innerStart + decorationHead.length, end: close };
		const marks = decorationHead.trimEnd();
		return {
			type: "decoration",
			...node,
			content,
			children: parseChildren(ctx, content, depth),
			marks: [...new Set(marks)].join(""),
			level: marks.split("*").length - 1,
		};
	}
	return null;
}

function icon(node: Span, inner: string): InlineNode | null {
	const suffixAt = inner.search(ICON_SUFFIX);
	if (suffixAt <= 0) return null;
	const starAt = inner.indexOf("*", suffixAt);
	return {
		type: "icon",
		...node,
		name: inner.slice(0, suffixAt),
		count: starAt === -1 ? 1 : Number(inner.slice(starAt + 1)),
	};
}

const image = (node: Span, src: string, link: string | null): ImageNode => ({
	type: "image",
	...node,
	src,
	link,
});

/** [URL]、[URL 表示文字]、[画像URL]、[画像URL リンク先URL]、[リンク先URL 画像URL] */
function urlFirst(node: Span, inner: string): InlineNode | null {
	const url = URL_FIRST.exec(inner)?.[0];
	if (url === undefined) return null;
	const innerStart = node.start + 1;
	const rest = inner.slice(url.length);
	const label = rest.trim();
	const secondUrl = WHOLE_URL.test(label) ? label : null;

	if (label === "" || secondUrl !== null) {
		if (IMAGE_URL.test(url)) return image(node, url, secondUrl);
		if (secondUrl !== null && IMAGE_URL.test(secondUrl)) return image(node, secondUrl, url);
	}
	if (label === "") {
		const content = { start: innerStart, end: innerStart + url.length };
		return { type: "external-link", ...node, content, url };
	}
	const labelStart = innerStart + inner.length - rest.trimStart().length;
	const content = { start: labelStart, end: labelStart + label.length };
	return { type: "external-link", ...node, content, url };
}

/** [表示文字 URL] */
function urlLast(node: Span, inner: string): InlineNode | null {
	const separatorAt = inner.search(URL_LAST);
	if (separatorAt === -1) return null;
	const innerStart = node.start + 1;
	const url = inner.slice(separatorAt + 1);
	const label = inner.slice(0, separatorAt).trim();
	if (label === "") {
		const content = { start: innerStart + separatorAt + 1, end: node.end - 1 };
		return { type: "external-link", ...node, content, url };
	}
	const labelStart = innerStart + inner.length - inner.trimStart().length;
	const content = { start: labelStart, end: labelStart + label.length };
	return { type: "external-link", ...node, content, url };
}

/** [/プロジェクト/ページ]、[/プロジェクト] */
function projectLink(node: Span, inner: string): InlineNode | null {
	if (!PROJECT_LINK.test(inner)) return null;
	const slashAt = inner.indexOf("/", 1);
	const project = slashAt === -1 ? inner.slice(1) : inner.slice(1, slashAt);
	const title = slashAt === -1 ? "" : inner.slice(slashAt + 1).trim();
	const content = { start: node.start + 1, end: node.end - 1 };
	return { type: "project-link", ...node, content, project, title: title === "" ? null : title };
}

function bracket(ctx: Context, open: number, depth: number): InlineNode | null {
	const close = ctx.closing.get(open);
	if (close === undefined) return null;
	const node = { start: open, end: close + 1 };

	const contained = container(ctx, node, depth);
	if (contained !== null) return contained;

	// ここから先の記法は、中に括弧を含められない。内側の括弧を先に解釈させる。
	const nextOpen = ctx.raw.indexOf("[", open + 1);
	if (nextOpen !== -1 && nextOpen < close) return null;
	const inner = ctx.raw.slice(open + 1, close);
	if (inner.trim() === "") return null;

	return (
		icon(node, inner) ??
		urlFirst(node, inner) ??
		urlLast(node, inner) ??
		projectLink(node, inner) ?? {
			type: "page-link",
			...node,
			content: { start: open + 1, end: close },
			title: inner.trim(),
		}
	);
}

/** position から始まる記法があれば、そのノードを返す。 */
function nodeAt(ctx: Context, position: number, end: number, depth: number): InlineNode | null {
	switch (ctx.raw.charAt(position)) {
		case "`":
			return code(ctx, position, end);
		case "[":
			return bracket(ctx, position, depth);
		case "#":
			return hashtag(ctx, position);
		case "h":
			return bareUrl(ctx, position);
		default:
			return null;
	}
}

/** range を、隙間も重なりもなく覆うノードの列にする。記法でない部分はテキストになる。 */
function parseRange(ctx: Context, range: Span, depth: number): InlineNode[] {
	const nodes: InlineNode[] = [];
	let textStart = range.start;
	let position = range.start;
	const flushText = (end: number) => {
		if (end > textStart) nodes.push({ type: "text", start: textStart, end });
	};

	while (position < range.end) {
		const node = nodeAt(ctx, position, range.end, depth);
		if (node === null) {
			position += 1;
			continue;
		}
		flushText(position);
		nodes.push(node);
		position = node.end;
		textStart = node.end;
	}
	flushText(range.end);
	return nodes;
}

/**
 * 1行を解析する。
 * 解析は行ごとに独立で、どんな文字列を渡しても例外を出さない。
 * 複数行にまたがる記法(コードブロック、テーブル)は、ここでは扱わない。
 */
export function parseLine(raw: string): ParsedLine {
	const { indent } = parseIndent(raw);
	const ctx = { raw, closing: findClosingBrackets(raw) };
	const rest = { start: indent, end: raw.length };
	if (raw.charAt(indent) !== ">") return { indent, nodes: parseRange(ctx, rest, 0) };

	const content = { start: indent + 1, end: raw.length };
	const children = parseRange(ctx, content, 1);
	return { indent, nodes: [{ type: "quote", ...rest, content, children }] };
}
