import type { PageCard } from "@amime/sync";
import { pageHref } from "../editor/links.ts";
import "./page-card.css";

const timeFormat = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });

type PageCardsProps = {
	readonly pages: readonly PageCard[];
	/** カードの名前の見出しの段階。カードの並びに見出しを付けるときは、その1つ下にする。 */
	readonly heading?: "h2" | "h3" | "h4";
};

/** ページのカードの並び。カードは、名前・冒頭の本文・画像・更新した時刻を見せる。押すと、そのページを開く。 */
export function PageCards({ pages, heading: Heading = "h2" }: PageCardsProps) {
	return (
		<ul className="cards">
			{pages.map((page) => {
				const updated = new Date(page.updated);
				return (
					<li className="card" key={page.id}>
						<a className="card-link" href={pageHref(page.title)}>
							<Heading className="card-title">{page.title}</Heading>
							{page.pinned && <span className="card-pin">固定</span>}
							{page.image !== null && (
								<img
									className="card-image"
									src={page.image}
									// 画像の内容は分からない。名前は見出しにあるので、代替テキストは空にする。
									alt=""
									loading="lazy"
									// 画像の置き場所に、見ているページのURLを伝えない。
									referrerPolicy="no-referrer"
								/>
							)}
							{page.descriptions.map((text, index) => (
								// 冒頭の本文は、並びが変わらない。同じ本文の行もあるので、位置で識別する。
								// biome-ignore lint/suspicious/noArrayIndexKey: 上のとおり。
								<p className="card-text" key={index}>
									{text}
								</p>
							))}
							<time className="card-time" dateTime={updated.toISOString()}>
								{timeFormat.format(updated)}
							</time>
						</a>
					</li>
				);
			})}
		</ul>
	);
}
