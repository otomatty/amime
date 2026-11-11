/**
 * 文字列をURLのパスの1区間にする。
 * 対になっていないサロゲート(壊れた文字)があると encodeURIComponent が例外を出すので、
 * 先に置換文字(U+FFFD)へ置き換える。貼り付けなどで本文に紛れ込んでも、描画を止めない。
 */
const encodeSegment = (text: string): string => encodeURIComponent(text.toWellFormed());

/** タイトルをURLのパスの1区間にする。空白はアンダースコアにそろえる。 */
const toPathSegment = (title: string): string => encodeSegment(title.replaceAll(" ", "_"));

/**
 * 同じプロジェクトのページへのリンク先。
 * いまのページからの相対パスにするので、プロジェクトのパスが何であっても同じ階層の中で移動する。
 */
export function pageHref(title: string): string {
	return `./${toPathSegment(title)}`;
}

/** 他のプロジェクトのページ(title が null ならプロジェクトのトップ)へのリンク先。 */
export function projectHref(project: string, title: string | null): string {
	const base = `/${encodeSegment(project)}/`;
	return title === null ? base : base + toPathSegment(title);
}
