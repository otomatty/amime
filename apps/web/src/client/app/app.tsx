import { Editor } from "../features/editor/editor.tsx";

/** 動作確認用の初期内容。P2でサーバーから取得したページに置き換える。 */
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

export function App() {
	return (
		<main className="app">
			<h1>Amime</h1>
			<article className="page">
				<Editor initialLines={SAMPLE_LINES} />
			</article>
		</main>
	);
}
