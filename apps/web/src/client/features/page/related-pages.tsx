import type { PageLinks } from "@amime/sync";
import { useId } from "react";
import { pageHref } from "../editor/links.ts";
import { PageCards } from "../pages/page-card.tsx";
import "./related-pages.css";

/** 見出しの付いた、カードのまとまり。 */
function Group({
	children,
	pages,
}: {
	readonly children: React.ReactNode;
	readonly pages: PageLinks["related"];
}) {
	const heading = useId();
	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset は、入力欄のまとまりに使う。ここは、見出しの付いたカードのまとまり。
		<div className="related-group" role="group" aria-labelledby={heading}>
			<h3 className="related-heading" id={heading}>
				{children}
			</h3>
			<PageCards pages={pages} heading="h4" />
		</div>
	);
}

/**
 * 関連するページ(ADR-0027)。ページの下に並べる。
 * このページがリンクしているページと、このページへリンクしているページ。
 * それに、同じリンクを持つページ(2ホップ先)を、リンク先ごとにまとめたもの。
 */
export function RelatedPages({ links }: { readonly links: PageLinks }) {
	if (links.related.length === 0 && links.hops.length === 0) return null;
	return (
		<section className="related" aria-labelledby="related-title">
			<h2 className="related-title" id="related-title">
				関連するページ
			</h2>
			{links.related.length > 0 && (
				<Group pages={links.related}>このページとつながっているページ</Group>
			)}
			{links.hops.map((group) => (
				<Group key={group.title} pages={group.pages}>
					「
					<a
						className="link"
						href={pageHref(group.title)}
						data-missing={group.exists ? undefined : true}
					>
						{group.title}
					</a>
					」にもリンクしているページ
				</Group>
			))}
		</section>
	);
}
