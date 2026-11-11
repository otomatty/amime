import { LineView } from "../features/page/line-view.tsx";

/** P0の動作確認用。P1でエディタに、P2でサーバーから取得したページに置き換える。 */
const SAMPLE_LINES = [
	"はじめに",
	"行頭に空白を入れると箇条書きになります",
	" 1段目",
	"  2段目",
	" \t全角スペースやタブも同じ深さとして数えます",
];

export function App() {
	return (
		<main className="app">
			<h1>Amime</h1>
			<article className="page">
				{SAMPLE_LINES.map((text, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: サンプルの行は並び替えも増減もしない。行IDはP2で導入する。
					<LineView key={index} text={text} />
				))}
			</article>
		</main>
	);
}
