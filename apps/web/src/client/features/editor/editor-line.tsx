import { segmentGraphemes } from "@amime/editor-core";
import { parseIndent } from "@amime/parser";
import { type CSSProperties, Fragment } from "react";

type EditorLineProps = {
	/** ページ内での行番号(0始まり)。 */
	readonly index: number;
	/** 行頭の空白を含む、行の生のテキスト。 */
	readonly text: string;
	/** この行にカーソルがあるときの文字位置。なければ null。 */
	readonly caretColumn: number | null;
	/** 日本語入力などで変換中の文字列。変換中でなければ null。 */
	readonly composing: string | null;
};

/**
 * 1行を、1文字ずつの要素として描画する。
 * 各要素に文字位置を持たせることで、クリック位置からカーソル位置を求められる。
 * 行頭の空白は文字として表示せず、インデント1段ぶんの幅を持つ要素にする。
 */
export function EditorLine({ index, text, caretColumn, composing }: EditorLineProps) {
	const { indent } = parseIndent(text);
	const style = { "--indent": indent } as CSSProperties;

	const caret = (
		<>
			{composing && (
				<span className="composing" data-testid="composing">
					{composing}
				</span>
			)}
			<span className="caret" data-testid="caret" />
		</>
	);

	return (
		<div
			className="line"
			data-testid="line"
			data-line={index}
			data-indent={indent}
			data-text={text}
			style={style}
		>
			{segmentGraphemes(text).map((grapheme) => {
				const position = {
					"data-column": grapheme.column,
					"data-end": grapheme.column + grapheme.text.length,
				};
				return (
					<Fragment key={grapheme.column}>
						{grapheme.column === caretColumn && caret}
						{grapheme.column < indent ? (
							<span
								className="indent"
								data-bullet={grapheme.column === indent - 1 ? "" : undefined}
								{...position}
							/>
						) : (
							<span className="char" {...position}>
								{grapheme.text}
							</span>
						)}
					</Fragment>
				);
			})}
			{caretColumn === text.length && caret}
		</div>
	);
}
