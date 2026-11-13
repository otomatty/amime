/**
 * URLのパスからページ名を求める。トップ(/)はページではないので null。
 *
 * パスの最後の部分をページ名にする。ページの中のリンクは同じ階層を指す相対パス(./ページ名)なので、
 * 区切りのあるパスで開いても、リンク先を同じ規則で求められる。
 * 手前の部分は、プロジェクト(P4)が入るまで使わない。ページ名に含まれる「/」は、URLでは符号化されている。
 */
export function pageNameFromPath(pathname: string): string | null {
	const raw = pathname.slice(pathname.lastIndexOf("/") + 1);
	if (raw === "") return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}
