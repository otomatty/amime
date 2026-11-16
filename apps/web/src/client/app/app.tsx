import { type PageId, type ProjectInfo, parsePageId } from "@tsuzuri/sync";
import { useState } from "react";
import { AccountProvider, useAccount } from "../features/account/account.tsx";
import { AccountMenu } from "../features/account/account-menu.tsx";
import { Profile } from "../features/account/profile.tsx";
import { Editor } from "../features/editor/editor.tsx";
import { Page } from "../features/page/page.tsx";
import { PendingPages } from "../features/page/pending-pages.tsx";
import { PageList } from "../features/pages/page-list.tsx";
import { Home } from "../features/project/home.tsx";
import { InvitePage } from "../features/project/invite.tsx";
import { ProjectGate } from "../features/project/project-gate.tsx";
import { parseRoute, type Route } from "../features/project/route.ts";
import { ProjectSettings } from "../features/project/settings.tsx";
import { SearchResults } from "../features/search/search-results.tsx";
import { TitleSearch } from "../features/search/title-search.tsx";

/** 試し書きのページの初期内容。 */
const SAMPLE_LINES = [
	"はじめに",
	"行頭に空白を入れると箇条書きになります",
	" 1段目",
	"  2段目",
	" \t全角スペースやタブも同じ深さとして数えます",
	"この画面で自由に編集できます(まだ保存はされません)",
	"[リンク] や #タグ でページをつなげます",
	"[* 太字] [/ 斜体] [- 打ち消し] [_ 下線] [[強調]] `code`",
	" 行を押すと、その行だけ記法がそのまま見えます",
	"> 引用もできます [Cloudflare https://www.cloudflare.com/]",
	"code:hello.js",
	" function hello() {",
	"   return items[0]; // [リンク] にはならない",
	" }",
	"table:今週の予定",
	" 月\t火\t水",
	" [定例会議]\t`deploy`\tお休み",
	"$ pnpm dev",
];

/** 保存されない試し書きのページ。ログインしなくても、書き心地を試せる。 */
function Playground() {
	return (
		<>
			<p className="page-status">この画面は試し書き用です。内容は保存されません。</p>
			<Editor initialLines={SAMPLE_LINES} />
		</>
	);
}

/**
 * プロジェクトのトップ。ページの一覧を表示する(ADR-0025)。
 * URLに ?q= で語が付いていれば、本文を探した結果を表示する(ADR-0031)。
 */
function ProjectTop({
	project,
	pageId,
}: {
	readonly project: ProjectInfo;
	/** URLに ?page= で付いていたページID。付いていなければ null。 */
	readonly pageId: PageId | null;
}) {
	// 端末内に残った変更のページを、IDで開く(ADR-0042)。名前からは引けなくなったページにも使う。
	if (pageId !== null) {
		return (
			<article className="page">
				<Page id={pageId} readOnly={project.role === null} />
			</article>
		);
	}
	const query = new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
	if (query !== "") return <SearchResults query={query} />;
	return (
		<>
			{project.role !== null && (
				<p className="project-links">
					<a href={`/settings/${project.name}`}>メンバーと設定</a>
				</p>
			)}
			{project.role !== null && <PendingPages />}
			<PageList readOnly={project.role === null} />
		</>
	);
}

/**
 * プロジェクトの、ページを探す欄。ログインの状態が変わったら、作り直す
 * (ログアウトしたあとに、前に読み込んだ名前の候補を、残さない)。
 */
function ProjectSearch() {
	const { state } = useAccount();
	return <TitleSearch key={state?.user?.id ?? ""} />;
}

/** URLの ?page= に付いたページID(ADR-0042)。形が違えば null。 */
function pageIdFromUrl(): PageId | null {
	const id = parsePageId(new URLSearchParams(window.location.search).get("page"));
	return id.ok ? id.value : null;
}

/** URLのパスが指すものを表示する(ADR-0033)。 */
function Content({ route }: { readonly route: Route }) {
	// ?page= は、開いたときのURLから1度だけ読む。開いたページは、URLを名前のURLに変える。
	// そのあとで描き直しても(ログアウトした)、同じページを表示する。
	const [pageId] = useState(pageIdFromUrl);
	if (route.kind === "home") {
		// URLに ?playground を付けたときは、保存されない試し書きのページを表示する。
		const playground = new URLSearchParams(window.location.search).has("playground");
		return playground ? (
			<article className="page">
				<Playground />
			</article>
		) : (
			<Home />
		);
	}
	if (route.kind === "invite") return <InvitePage token={route.token} />;
	if (route.kind === "profile") return <Profile />;
	return (
		<ProjectGate name={route.project}>
			{(project) => {
				if (route.kind === "settings") return <ProjectSettings project={project} />;
				if (route.kind === "project") return <ProjectTop project={project} pageId={pageId} />;
				return (
					<article className="page">
						<Page name={route.name} readOnly={project.role === null} />
					</article>
				);
			}}
		</ProjectGate>
	);
}

export function App() {
	const route = parseRoute(window.location.pathname);
	// プロジェクトのトップは、末尾に / を付けたURLにそろえる。ページへのリンクは、同じ階層を指す相対パスなので、
	// / がないと、プロジェクトの外を指してしまう。
	if (route.kind === "project" && !window.location.pathname.endsWith("/")) {
		const { pathname, search, hash } = window.location;
		window.history.replaceState(window.history.state, "", `${pathname}/${search}${hash}`);
	}
	return (
		<AccountProvider>
			<main className="app">
				<header className="app-header">
					<h1 className="app-title">
						<a href="/">Tsuzuri</a>
						{"project" in route && (
							<>
								{" / "}
								<a href={`/${encodeURIComponent(route.project)}/`}>{route.project}</a>
							</>
						)}
					</h1>
					{(route.kind === "project" || route.kind === "page") && <ProjectSearch />}
					<AccountMenu />
				</header>
				<Content route={route} />
			</main>
		</AccountProvider>
	);
}
