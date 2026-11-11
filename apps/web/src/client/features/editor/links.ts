/** タイトルをURLのパスの1区間にする。空白はアンダースコアにそろえる。 */
const toPathSegment = (title: string): string => encodeURIComponent(title.replaceAll(" ", "_"));

/**
 * 同じプロジェクトのページへのリンク先。
 * いまのページからの相対パスにするので、プロジェクトのパスが何であっても同じ階層の中で移動する。
 */
export function pageHref(title: string): string {
	return `./${toPathSegment(title)}`;
}

/** 他のプロジェクトのページ(title が null ならプロジェクトのトップ)へのリンク先。 */
export function projectHref(project: string, title: string | null): string {
	const base = `/${encodeURIComponent(project)}/`;
	return title === null ? base : base + toPathSegment(title);
}
