import {
	type Command,
	commandForKey,
	type EditorState,
	insertText,
	setCursor,
} from "@amime/editor-core";
import { classifyLines } from "@amime/parser";
import {
	type CompositionEvent,
	type KeyboardEvent,
	type MouseEvent,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { EditorLine } from "./editor-line.tsx";
import { cursorFromPoint } from "./hit-test.ts";
import { groupLines } from "./line-groups.ts";
import "./editor.css";

type EditorProps = {
	readonly initialLines: readonly string[];
};

/** 単独で押されても、編集の操作としては扱わないキー。 */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** 変換中のキー操作に付く keyCode。Safari は確定直後の Enter にもこの値を付ける。 */
const KEY_CODE_COMPOSING = 229;

const initialState = (lines: readonly string[]): EditorState => ({
	// エディタは常に1行以上を持つ。
	lines: lines.length > 0 ? lines : [""],
	cursor: { line: 0, column: 0 },
});

const applyCommand = (state: EditorState, command: Command): EditorState => command(state);

/**
 * 行エディタ。表示は自前で描画し、文字入力は画面に見えない textarea で受け取る(ADR-0010)。
 * 編集の規則はすべて @amime/editor-core にあり、ここはイベントを操作に変換するだけ。
 */
export function Editor({ initialLines }: EditorProps) {
	const [state, dispatch] = useReducer(applyCommand, initialLines, initialState);
	const [composing, setComposing] = useState<string | null>(null);
	const [focused, setFocused] = useState(false);
	// 行の役割(タイトル、コードブロックの中身など)は、ページ全体の行の並びから決まる。
	const roles = useMemo(() => classifyLines(state.lines), [state.lines]);
	const groups = useMemo(() => groupLines(roles.map((role) => role.kind)), [roles]);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// 再描画を待たずに参照するため、変換中かどうかは ref にも持つ。
	const isComposing = useRef(false);
	// Esc の直後の Tab だけはインデントにせず、フォーカスの移動に使う。
	const tabMovesFocus = useRef(false);

	useLayoutEffect(() => {
		const input = inputRef.current;
		const caret = rootRef.current?.querySelector<HTMLElement>(".caret");
		if (!input || !caret) return;
		// 変換候補のウィンドウがカーソルの近くに出るよう、textarea をカーソルの位置に重ねる。
		input.style.top = `${caret.offsetTop}px`;
		input.style.left = `${caret.offsetLeft}px`;
		// キー操作は既定の動作を止めているため、ブラウザは自動でスクロールしない。代わりに行う。
		if (focused) caret.scrollIntoView({ block: "nearest", inline: "nearest" });
	});

	/**
	 * textarea に溜まった文字列を取り出して挿入する。
	 * 確定した文字列の出どころを textarea の値だけにすることで、
	 * input と compositionend の発火順がブラウザで違っても、二重に挿入しない。
	 */
	const flushInput = () => {
		const input = inputRef.current;
		if (!input || input.value === "") return;
		const text = input.value;
		input.value = "";
		dispatch((current) => insertText(current, text));
	};

	const handleInput = () => {
		if (!isComposing.current) flushInput();
	};

	const handleCompositionStart = () => {
		isComposing.current = true;
		setComposing("");
	};

	const handleCompositionUpdate = (event: CompositionEvent) => {
		setComposing(event.data);
	};

	const handleCompositionEnd = () => {
		isComposing.current = false;
		setComposing(null);
		flushInput();
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		// Tab をインデントに使うため、Esc の直後の Tab だけはブラウザに任せ、編集欄から抜けられるようにする。
		// Shift+Tab では Shift 単独の keydown が先に届くので、修飾キーだけの押下では状態を変えない。
		if (MODIFIER_KEYS.has(event.key)) return;
		const escaped = tabMovesFocus.current;
		tabMovesFocus.current = event.key === "Escape" && !isComposing.current;
		if (tabMovesFocus.current || (escaped && event.key === "Tab")) return;

		const composingNow =
			isComposing.current || event.nativeEvent.isComposing || event.keyCode === KEY_CODE_COMPOSING;
		if (composingNow) return;
		const command = commandForKey(
			{
				key: event.key,
				shift: event.shiftKey,
				ctrl: event.ctrlKey,
				alt: event.altKey,
				meta: event.metaKey,
			},
			{ inTableRow: roles[state.cursor.line]?.kind === "table-row" },
		);
		if (!command) return;
		event.preventDefault();
		dispatch(command);
	};

	const handleMouseDown = (event: MouseEvent) => {
		// リンクを押したときは何もせず、ブラウザの既定の動作(リンク先への移動)に任せる。
		if (event.target instanceof Element && event.target.closest("a[href]")) return;
		// 既定の動作(フォーカスの移動と文字列の選択)を止め、入力先を textarea に保つ。
		event.preventDefault();
		inputRef.current?.focus();
		if (event.target instanceof Element) {
			const target = cursorFromPoint(event.target, event.clientX, event.clientY);
			dispatch((current) => setCursor(current, target));
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 操作を受け付けるのは中の textarea。ここはマウスでカーソル位置を決めるための領域で、キーボード操作は textarea が受ける。
		<div
			ref={rootRef}
			className="editor"
			data-testid="editor"
			data-focused={focused}
			onMouseDown={handleMouseDown}
		>
			{/* 行より前に置く。Tab の順序が「編集欄 → 本文中のリンク」になり、Shift+Tab では編集欄の前へ抜けられる。 */}
			<textarea
				ref={inputRef}
				className="editor-input"
				aria-label="ページの本文"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				rows={1}
				onInput={handleInput}
				onKeyDown={handleKeyDown}
				onCompositionStart={handleCompositionStart}
				onCompositionUpdate={handleCompositionUpdate}
				onCompositionEnd={handleCompositionEnd}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
			/>
			{groups.map((group) => {
				const lines = state.lines.slice(group.start, group.end).map((text, offset) => {
					const index = group.start + offset;
					const role = roles[index];
					const isCursorLine = focused && state.cursor.line === index;
					return (
						<EditorLine
							// 行IDは同期を実装するP2で導入する。それまでは行番号で識別する。
							key={index}
							index={index}
							text={text}
							kind={role?.kind ?? "text"}
							blockIndent={role?.blockIndent ?? 0}
							// 編集中の行は、フォーカスがあるときのカーソル行だけ。それ以外の行は記法を装飾して見せる。
							caretColumn={isCursorLine ? state.cursor.column : null}
							composing={isCursorLine ? composing : null}
						/>
					);
				});
				if (!group.table) return lines;
				// テーブルの行は1つの枠で囲み、列の幅をそろえる。
				return (
					<div className="table-block" key={`table-${group.start}`}>
						{lines}
					</div>
				);
			})}
		</div>
	);
}
