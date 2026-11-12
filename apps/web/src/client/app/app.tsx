import { Editor } from "../features/editor/editor.tsx";
import { Page } from "../features/page/page.tsx";
import { pageNameFromPath } from "../features/page/route.ts";

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

/** トップに表示する、保存されない試し書きのページ。P3 でページの一覧に置き換える。 */
function Playground() {
	return (
		<>
			<p className="page-status">この画面は試し書き用です。内容は保存されません。</p>
			<Editor initialLines={SAMPLE_LINES} />
		</>
	);
}

export function App() {
	const name = pageNameFromPath(window.location.pathname);
	return (
		<main className="app">
			<h1>Amime</h1>
			<article className="page">{name === null ? <Playground /> : <Page name={name} />}</article>
		</main>
	);
}
