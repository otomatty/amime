import { parseIndent } from "@amime/parser";
import type { CSSProperties } from "react";

type LineViewProps = {
	/** 行頭の空白を含む、行の生のテキスト。 */
	readonly text: string;
};

/** 1行を表示する。行頭の空白はインデントの深さとして描画し、文字としては表示しない。 */
export function LineView({ text }: LineViewProps) {
	const { indent, text: body } = parseIndent(text);
	const style = { "--indent": indent } as CSSProperties;

	return (
		<div className="line" data-testid="line" data-indent={indent} style={style}>
			{indent > 0 && <span className="bullet" data-testid="bullet" aria-hidden="true" />}
			<span>{body}</span>
		</div>
	);
}
