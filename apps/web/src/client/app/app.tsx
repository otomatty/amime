import { Editor } from "../features/editor/editor.tsx";

/** 動作確認用の初期内容。P2でサーバーから取得したページに置き換える。 */
const SAMPLE_LINES = [
	"はじめに",
	"行頭に空白を入れると箇条書きになります",
	" 1段目",
	"  2段目",
	" \t全角スペースやタブも同じ深さとして数えます",
	"この画面で自由に編集できます(まだ保存はされません)",
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
