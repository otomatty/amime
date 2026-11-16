import { type PendingPageSummary, pendingPages } from "@tsuzuri/sync";
import { useId, useState } from "react";
import { currentProject } from "../project/route.ts";
import { browserStorage, listPendingRecords } from "./pending-store.ts";
import { formatSavedAt } from "./saved-at.ts";
import "./pending-pages.css";

/**
 * この端末に、送れていない変更が残っているページ(ADR-0042、Issue #18)。プロジェクトのトップに出す。
 * 名前が変わった、名前を別のページに取られた、といったときにも、ここからIDで開いて送れる。
 * 開いたときに1度だけ見る。残っている記録がなければ、何も出さない。
 */
export function PendingPages() {
	const headingId = useId();
	const [pages] = useState<readonly PendingPageSummary[]>(() =>
		pendingPages(listPendingRecords(browserStorage()), currentProject() ?? ""),
	);
	if (pages.length === 0) return null;
	return (
		<section className="pending-pages" aria-labelledby={headingId}>
			<h2 id={headingId}>この端末に、送れていない変更があるページ</h2>
			<p>ページを開くと、残っている変更を送ります。</p>
			<ul>
				{pages.map((page) => (
					<li key={page.id}>
						<a href={`./?page=${encodeURIComponent(page.id)}`}>{page.title}</a>{" "}
						<span className="pending-pages-time">{formatSavedAt(page.savedAt)}</span>
					</li>
				))}
			</ul>
		</section>
	);
}
