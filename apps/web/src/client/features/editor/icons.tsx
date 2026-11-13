import { toTitleLc } from "@amime/shared";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

/** 名前から、アイコンの画像のURLを引く。引けなければ null。 */
export type IconSource = (name: string) => Promise<string | null>;

/**
 * アイコンの画像のURLを引くものを作る。同じ名前は、1回だけ引く(同じアイコンが、ページに何度も出てくる)。
 * 名前は、ページの名前と同じ決まりで照らし合わせる。引くのに失敗した名前は、次に引き直す。
 */
export function createIconSource(load: IconSource): IconSource {
	const found = new Map<string, Promise<string | null>>();
	return (name) => {
		const key = toTitleLc(name);
		const known = found.get(key);
		if (known !== undefined) return known;
		const loading = load(name).catch(() => {
			found.delete(key);
			return null;
		});
		found.set(key, loading);
		return loading;
	};
}

const IconSourceContext = createContext<IconSource | null>(null);

/** この下の `[名前.icon]` が、画像を引く先を決める(ADR-0035)。 */
export function IconSourceProvider({
	source,
	children,
}: {
	readonly source: IconSource;
	readonly children: ReactNode;
}) {
	return <IconSourceContext.Provider value={source}>{children}</IconSourceContext.Provider>;
}

/**
 * `[名前.icon]` の中身。画像のURLを引けたら画像を、引けなければ名前の文字を表示する。
 * 画像の置き場所に、いまのページのURLを伝えない。
 */
export function IconImage({ name }: { readonly name: string }) {
	const source = useContext(IconSourceContext);
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		if (source === null) return;
		let cancelled = false;
		void source(name).then((found) => {
			if (!cancelled) setUrl(found);
		});
		return () => {
			cancelled = true;
		};
	}, [source, name]);
	if (url === null) return name;
	return (
		<img
			className="icon-image"
			src={url}
			alt={name}
			referrerPolicy="no-referrer"
			// 読み込めなかった画像は、名前の文字に戻す。
			onError={() => setUrl(null)}
		/>
	);
}
