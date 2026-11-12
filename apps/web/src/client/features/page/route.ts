/**
 * URLのパスからページ名を求める。トップ(/)はページではないので null。
 * P3 でページの一覧と画面内の移動を入れるまで、パスの全体を1つのページ名として扱う。
 */
export function pageNameFromPath(pathname: string): string | null {
	const raw = pathname.slice(1);
	if (raw === "") return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** ページ名から、新しいページの最初のタイトルを作る。リンクのURLは空白をアンダースコアにしているので、空白に戻す。 */
export function titleFromName(name: string): string {
	return name.replaceAll("_", " ");
}
