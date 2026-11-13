/** URLのパスが指すもの。 */
export type Route =
	/** トップ。参加しているプロジェクトの一覧。 */
	| { readonly kind: "home" }
	/** プロジェクトのトップ。ページの一覧。 */
	| { readonly kind: "project"; readonly project: string }
	/** プロジェクトのページ。 */
	| { readonly kind: "page"; readonly project: string; readonly name: string };

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * URLのパスから、表示するものを決める(ADR-0033)。パスは「/プロジェクト/ページ」。
 *
 * ページの名前は、パスの最後の部分にする。ページの中のリンクは同じ階層を指す相対パス(./ページ名)なので、
 * 区切りがさらにあるパスで開いても、リンク先を同じ規則で求められる。
 * ページの名前に含まれる「/」は、URLでは符号化されている。
 */
export function parseRoute(pathname: string): Route {
	const [first = "", ...rest] = pathname.split("/").slice(1);
	if (first === "") return { kind: "home" };
	// プロジェクトの名前は、大文字と小文字を区別しない(サーバーも、小文字にそろえて探す)。
	const project = decode(first).toLowerCase();
	const last = rest.at(-1) ?? "";
	return last === "" ? { kind: "project", project } : { kind: "page", project, name: decode(last) };
}

/**
 * この画面で開いているプロジェクトの名前。トップでは null。
 * 別のプロジェクトへ移るときは、ページを読み込み直す。画面を開いているあいだは、変わらない。
 */
export function currentProject(): string | null {
	const route = parseRoute(window.location.pathname);
	return route.kind === "home" ? null : route.project;
}
