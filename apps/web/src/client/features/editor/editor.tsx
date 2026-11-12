import {
	applyEdit,
	bindingForKey,
	type Command,
	type Cursor,
	createHistory,
	deleteSelection,
	type EditGroup,
	type EditorState,
	type History,
	insertText,
	redo,
	selectedText,
	selectionRange,
	selectTo,
	setCursor,
	undo,
} from "@amime/editor-core";
import { classifyLines } from "@amime/parser";
import {
	type ClipboardEvent,
	type CompositionEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { EditorLine } from "./editor-line.tsx";
import { cursorFromPoint, LINE_END } from "./hit-test.ts";
import { groupLines } from "./line-groups.ts";
import { lineSelection } from "./line-selection.ts";
import "./editor.css";

type EditorProps = {
	readonly initialLines: readonly string[];
};

/** 単独で押されても、編集の操作としては扱わないキー。 */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** 変換中のキー操作に付く keyCode。Safari は確定直後の Enter にもこの値を付ける。 */
const KEY_CODE_COMPOSING = 229;

/** Mac では Command キー、それ以外では Ctrl キーとの組み合わせを使う。 */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const LINE_BREAK = /[\r\n]/;

const initialState = (lines: readonly string[]): EditorState => ({
	// エディタは常に1行以上を持つ。
	lines: lines.length > 0 ? lines : [""],
	cursor: { line: 0, column: 0 },
});

type Action =
	| {
			readonly type: "edit";
			readonly command: Command;
			/** 続けて行ったときに1回の取り消しにまとめる編集の種類。 */
			readonly group: EditGroup | null;
			/** 操作した時刻。reducer を純粋に保つため、呼び出し側で測って渡す。 */
			readonly at: number;
	  }
	| { readonly type: "undo" }
	| { readonly type: "redo" };

function reducer(history: History, action: Action): History {
	switch (action.type) {
		case "edit":
			return applyEdit(history, action.command, action);
		case "undo":
			return undo(history);
		case "redo":
			return redo(history);
	}
}

/**
 * 行エディタ。表示は自前で描画し、文字入力は画面に見えない textarea で受け取る(ADR-0010)。
 * 編集の規則はすべて @amime/editor-core にあり、ここはイベントを操作に変換するだけ。
 */
export function Editor({ initialLines }: EditorProps) {
	const [history, dispatch] = useReducer(reducer, initialLines, (lines) =>
		createHistory(initialState(lines)),
	);
	const state = history.present;
	const [composing, setComposing] = useState<string | null>(null);
	const [focused, setFocused] = useState(false);
	// 行の役割(タイトル、コードブロックの中身など)は、ページ全体の行の並びから決まる。
	const roles = useMemo(() => classifyLines(state.lines), [state.lines]);
	const groups = useMemo(() => groupLines(roles.map((role) => role.kind)), [roles]);
	/** 指定した行がテーブルの行なら、そのインデントの文字数(始まりの行より1つ深いところまで)。 */
	const tableRowIndentAt = (line: number): number | null => {
		const role = roles[line];
		return role?.kind === "table-row" ? role.blockIndent + 1 : null;
	};
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// 再描画を待たずに参照するため、変換中かどうかは ref にも持つ。
	const isComposing = useRef(false);
	// Esc の直後の Tab だけはインデントにせず、フォーカスの移動に使う。
	const tabMovesFocus = useRef(false);
	// ドラッグ中だけ window に付けている監視を外す関数。
	const stopDrag = useRef<(() => void) | null>(null);

	/** 操作を実行する。文書が変わったら、取り消せるように履歴に積まれる。 */
	const run = (command: Command, group: EditGroup | null = null) => {
		dispatch({ type: "edit", command, group, at: Date.now() });
	};

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

	// 画面から外れるときに、ドラッグの監視が残らないようにする。
	useEffect(() => () => stopDrag.current?.(), []);

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
		// 続けて打った文字は1回の取り消しにまとめる。改行を含む入力(貼り付け)は単独の単位にする。
		run((current) => insertText(current, text), LINE_BREAK.test(text) ? null : "typing");
	};

	const handleInput = () => {
		if (!isComposing.current) flushInput();
	};

	const handleCompositionStart = () => {
		isComposing.current = true;
		setComposing("");
		// 変換中の文字列は選択した範囲と置き換わるものなので、先に消しておく。
		run(deleteSelection);
	};

	const handleCompositionUpdate = (event: CompositionEvent) => {
		setComposing(event.data);
	};

	const handleCompositionEnd = () => {
		isComposing.current = false;
		setComposing(null);
		flushInput();
	};

	/**
	 * コピー・切り取りのキーが押されたら、選択した文字列を textarea に入れて選択しておく。
	 * 操作そのものはブラウザに任せる。何も選択されていない textarea では、ブラウザによっては
	 * copy / cut のイベントが届かないので、届くようにするための準備。
	 */
	const prepareClipboard = (event: KeyboardEvent): boolean => {
		const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
		const key = event.key.toLowerCase();
		if (!modifier || (key !== "c" && key !== "x")) return false;
		const text = selectedText(state);
		const input = inputRef.current;
		if (text !== "" && input) {
			input.value = text;
			input.select();
		}
		return true;
	};

	/**
	 * 編集欄から抜けるためのキーかどうか。
	 * Tab をインデントに使うため、Esc の直後の Tab だけはブラウザに任せ、編集欄から抜けられるようにする。
	 */
	const leavesEditor = (event: KeyboardEvent): boolean => {
		const escaped = tabMovesFocus.current;
		tabMovesFocus.current = event.key === "Escape" && !isComposing.current;
		return tabMovesFocus.current || (escaped && event.key === "Tab");
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		// Shift+Tab では Shift 単独の keydown が先に届くので、修飾キーだけの押下では状態を変えない。
		if (MODIFIER_KEYS.has(event.key) || leavesEditor(event)) return;

		const composingNow =
			isComposing.current || event.nativeEvent.isComposing || event.keyCode === KEY_CODE_COMPOSING;
		if (composingNow || prepareClipboard(event)) return;
		const binding = bindingForKey(
			{
				key: event.key,
				shift: event.shiftKey,
				ctrl: event.ctrlKey,
				alt: event.altKey,
				meta: event.metaKey,
			},
			{ tableRowIndent: tableRowIndentAt(state.cursor.line), mac: IS_MAC },
		);
		if (!binding) return;
		event.preventDefault();
		if (binding.type === "command") run(binding.command, binding.group);
		else dispatch(binding);
	};

	/** 選択した範囲の生のテキストをクリップボードに入れる。選択していなければ何もしない。 */
	const copySelection = (event: ClipboardEvent): boolean => {
		const text = selectedText(state);
		if (text === "") return false;
		event.clipboardData.setData("text/plain", text);
		event.preventDefault();
		// prepareClipboard が入れた文字列を片付ける(次に打つ文字に混ざらないように)。
		if (inputRef.current) inputRef.current.value = "";
		return true;
	};

	const handleCut = (event: ClipboardEvent) => {
		if (copySelection(event)) run(deleteSelection);
	};

	/** 画面上の位置から、カーソルの移動先を求める。 */
	const cursorAt = (target: EventTarget | null, clientX: number, clientY: number): Cursor => {
		const root = rootRef.current;
		// 編集欄より上までドラッグしたら、文書の先頭まで。
		if (root && clientY < root.getBoundingClientRect().top) return { line: 0, column: 0 };
		if (!(target instanceof Element)) return { line: LINE_END, column: LINE_END };
		return cursorFromPoint(target, clientX, clientY);
	};

	/** ボタンを押しているあいだ、マウスの位置まで選択を広げる。編集欄の外へ出ても続ける。 */
	const startDrag = () => {
		stopDrag.current?.();
		const stop = () => {
			window.removeEventListener("mousemove", extend);
			window.removeEventListener("mouseup", stop);
			stopDrag.current = null;
		};
		const extend = (event: globalThis.MouseEvent) => {
			// ウィンドウの外でボタンを離した場合、mouseup は届かない。ボタンの状態で終わりを判断する。
			if (event.buttons !== 1) {
				stop();
				return;
			}
			const target = cursorAt(event.target, event.clientX, event.clientY);
			run((current) => selectTo(current, target));
		};
		window.addEventListener("mousemove", extend);
		window.addEventListener("mouseup", stop);
		stopDrag.current = stop;
	};

	const handleMouseDown = (event: MouseEvent) => {
		// リンクを押したときは何もせず、ブラウザの既定の動作(リンク先への移動)に任せる。
		if (event.target instanceof Element && event.target.closest("a[href]")) return;
		// 既定の動作(フォーカスの移動と文字列の選択)を止め、入力先を textarea に保つ。
		event.preventDefault();
		inputRef.current?.focus();
		const target = cursorAt(event.target, event.clientX, event.clientY);
		const extending = event.shiftKey;
		run((current) => (extending ? selectTo(current, target) : setCursor(current, target)));
		startDrag();
	};

	// 選択とカーソルは、編集欄にフォーカスがあるときだけ表示する。
	const selection = focused ? selectionRange(state) : null;

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
				onCopy={copySelection}
				onCut={handleCut}
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
					const selected = lineSelection(selection, index, text.length);
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
							selectionStart={selected.start}
							selectionEnd={selected.end}
							selectsLineBreak={selected.lineBreak}
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
