import {
	bindingForKey,
	type Command,
	type Cursor,
	completeLink,
	deleteSelection,
	type EditGroup,
	insertText,
	type KeyInput,
	selectedText,
	selectionRange,
	selectTo,
	setCursor,
	shortcutLetter,
} from "@amime/editor-core";
import { classifyLines } from "@amime/parser";
import type { Line, LineId } from "@amime/sync";
import {
	type ClipboardEvent,
	type CompositionEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { EditorLine } from "./editor-line.tsx";
import { createIdPrefix, createModel, type EditorAction } from "./editor-model.ts";
import { createEditorStore } from "./editor-store.ts";
import { cursorFromPoint, LINE_END } from "./hit-test.ts";
import { groupLines } from "./line-groups.ts";
import { lineSelection } from "./line-selection.ts";
import { CompletionList, useLinkCompletion } from "./link-completion.tsx";
import { caretsByLine, type RemoteCursor } from "./remote-carets.ts";
import "./editor.css";

type EditorProps = {
	/** 行IDを持たない最初の本文。 */
	readonly initialLines?: readonly string[];
	/** 行IDを持つ最初の文書(保存されているページ)。行があれば、こちらを使う。 */
	readonly initialDocument?: readonly Line[];
	/** 他の人の変更を取り込んだ文書の届け先。届くたびに、画面の文書を置き換える。 */
	readonly remote?: RemoteSource;
	/**
	 * 自分の編集で文書が変わるたびに、その場で呼ばれる(描画を待たない)。
	 * 外から届いた文書に置き換えたときは呼ばれない。
	 */
	readonly onChange?: (lines: readonly Line[]) => void;
	/** 同じページを開いている、他の人のカーソル(ADR-0023)。 */
	readonly others?: readonly RemoteCursor[];
	/**
	 * 自分のカーソルの位置が変わるたびに呼ばれる。行は行IDで指す。
	 * 編集欄にフォーカスがないあいだは null(カーソルを出していない)。
	 */
	readonly onCursor?: (cursor: { readonly line: LineId; readonly column: number } | null) => void;
	/** まだないページの名前(正規化したもの)。そのページへのリンクに、印を付ける(ADR-0027)。 */
	readonly missingLinks?: ReadonlySet<string>;
	/**
	 * リンクを書いている途中に、入力した名前の一部から、ページの名前の候補を探す(ADR-0030)。
	 * 渡さなければ、補完しない。
	 */
	readonly completeTitles?: (query: string) => Promise<readonly string[]>;
	/**
	 * 読むだけにする(公開のプロジェクトを、メンバーでない人が見るとき)。
	 * 入力を受け取る欄を置かず、カーソルも出さない。リンクは押せて、文字は選んでコピーできる。
	 */
	readonly readOnly?: boolean;
};

const NO_OTHERS: readonly RemoteCursor[] = [];
/** リンクを書ける行の種類。1行目(タイトル)と、コードの中では、リンクにならない。 */
const LINKABLE_KINDS: ReadonlySet<string | undefined> = new Set(["text", "table-row"]);

/** 外から届く文書の出どころ。apply を登録しておくと、文書が届くたびに呼ばれる。 */
type RemoteSource = {
	readonly subscribe: (apply: (lines: readonly Line[]) => void) => () => void;
};

/** 単独で押されても、編集の操作としては扱わないキー。 */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** 変換中のキー操作に付く keyCode。Safari は確定直後の Enter にもこの値を付ける。 */
const KEY_CODE_COMPOSING = 229;

/** Mac では Command キー、それ以外では Ctrl キーとの組み合わせを使う。 */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const LINE_BREAK = /[\r\n]/;

const keyInput = (event: KeyboardEvent): KeyInput => ({
	key: event.key,
	code: event.code,
	shift: event.shiftKey,
	ctrl: event.ctrlKey,
	alt: event.altKey,
	meta: event.metaKey,
});

/**
 * 行エディタ。表示は自前で描画し、文字入力は画面に見えない textarea で受け取る(ADR-0010)。
 * 編集の規則はすべて @amime/editor-core にあり、ここはイベントを操作に変換するだけ。
 */
export function Editor({
	initialLines,
	initialDocument,
	remote,
	onChange,
	others = NO_OTHERS,
	onCursor,
	missingLinks,
	completeTitles,
	readOnly = false,
}: EditorProps) {
	// 状態は、描画の外で、操作を受け取ったその場で進める(editor-store.ts を参照)。
	const [store] = useState(() =>
		createEditorStore(createModel({ initialLines, initialDocument }, createIdPrefix())),
	);
	const { present: state, tracker } = useSyncExternalStore(store.subscribe, store.getModel);
	/**
	 * 次の描画のあとで、カーソルが見える位置までスクロールするか。
	 * 自分の操作のあとにだけスクロールする。他の人の変更やカーソルが届いただけでは、スクロールしない
	 * (フォーカスを残したまま離れた場所を読んでいる人を、引き戻さないため)。
	 */
	const revealCaret = useRef(false);
	/** 自分の操作を実行する。 */
	const dispatch = (action: EditorAction) => {
		revealCaret.current = true;
		store.dispatch(action);
	};

	// 呼び出し側が渡す関数が変わっても、登録はし直さず、いつも最新のものを呼ぶ。
	const latestOnChange = useRef(onChange);
	useEffect(() => {
		latestOnChange.current = onChange;
	}, [onChange]);
	useEffect(() => store.onEdit((lines) => latestOnChange.current?.(lines)), [store]);

	useEffect(
		() => remote?.subscribe((lines) => store.dispatch({ type: "replace", lines })),
		[remote, store],
	);

	const [composing, setComposing] = useState<string | null>(null);
	const [focused, setFocused] = useState(false);

	// 自分のカーソルの位置を、行IDで外へ知らせる(他の人の画面に出すため)。
	const latestOnCursor = useRef(onCursor);
	useEffect(() => {
		latestOnCursor.current = onCursor;
	}, [onCursor]);
	const cursorLine = tracker.lines[state.cursor.line]?.id ?? null;
	const cursorColumn = state.cursor.column;
	useEffect(() => {
		const shown = focused && cursorLine !== null;
		latestOnCursor.current?.(shown ? { line: cursorLine, column: cursorColumn } : null);
	}, [focused, cursorLine, cursorColumn]);
	const othersByLine = useMemo(() => caretsByLine(others), [others]);
	// 行の役割(タイトル、コードブロックの中身など)は、ページ全体の行の並びから決まる。
	const roles = useMemo(() => classifyLines(state.lines), [state.lines]);
	const groups = useMemo(() => groupLines(roles.map((role) => role.kind)), [roles]);
	/** 指定した行がテーブルの行なら、そのインデントの文字数(始まりの行より1つ深いところまで)。 */
	const tableRowIndentAt = (line: number): number | null => {
		const role = roles[line];
		return role?.kind === "table-row" ? role.blockIndent + 1 : null;
	};
	// 選択とカーソルは、編集欄にフォーカスがあるときだけ表示する。
	const selection = focused ? selectionRange(state) : null;
	// リンクを書いている途中の、名前の候補(ADR-0030)。変換中や、範囲を選択しているあいだは出さない。
	const cursorRole = roles[state.cursor.line];
	const completable =
		focused && composing === null && selection === null && LINKABLE_KINDS.has(cursorRole?.kind);
	const { completion, move, dismiss } = useLinkCompletion({
		text: completable ? (state.lines[state.cursor.line] ?? null) : null,
		column: cursorColumn,
		line: cursorLine,
		role: cursorRole,
		search: completeTitles,
	});
	const completionId = useId();
	const completionRef = useRef<HTMLDivElement>(null);
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
		// 名前の候補は、カーソルのすぐ下に出す。編集欄の右端からは、はみ出させない。
		const list = completionRef.current;
		const root = rootRef.current;
		if (list && root) {
			const room = Math.max(root.clientWidth - list.offsetWidth, 0);
			list.style.top = `${caret.offsetTop + caret.offsetHeight}px`;
			list.style.left = `${Math.min(caret.offsetLeft, room)}px`;
		}
		// キー操作は既定の動作を止めているため、ブラウザは自動でスクロールしない。代わりに行う。
		if (focused && revealCaret.current) {
			caret.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
		revealCaret.current = false;
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
		// 範囲を選択していても、ここでは消さない。確定したときに、選択した範囲との置き換えを
		// 1回の編集として行う(変換を取り消せば何も変わらず、取り消しも1回で元に戻る)。
		isComposing.current = true;
		setComposing("");
	};

	const handleCompositionUpdate = (event: CompositionEvent) => {
		// 変換中の文字列が伸びると、カーソルも動く。
		revealCaret.current = true;
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
		const letter = shortcutLetter(keyInput(event));
		// AltGr(Ctrl+Alt として届く)との組み合わせは文字の入力なので、対象にしない。
		if (!modifier || event.altKey || (letter !== "c" && letter !== "x")) return false;
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

	/** 書いている途中のリンクを、選んだ名前で補完する。 */
	const pickTitle = (title: string) => {
		if (completion === null) return;
		run((current) => completeLink(current, completion.link, title, cursorRole));
		// タグは、補完したあともカーソルがタグの中に残る。候補を出したままにしない
		// (出したままだと、次の Enter が、また補完になる)。
		dismiss();
	};

	/**
	 * 名前の候補が出ているあいだの、候補のためのキー。扱ったら true。
	 * 上下の矢印キーで選び、Enter で補完し、Esc で閉じる。
	 * 候補を選んでいないときの Enter は、ここでは扱わない(改行になる)。
	 */
	const handleCompletionKey = (event: KeyboardEvent): boolean => {
		if (completion === null || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
			return false;
		}
		const picked = completion.titles[completion.active];
		if (event.key === "ArrowDown") move(1);
		else if (event.key === "ArrowUp") move(-1);
		else if (event.key === "Escape") dismiss();
		else if (event.key === "Enter" && picked !== undefined) pickTitle(picked);
		else return false;
		event.preventDefault();
		return true;
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		// Shift+Tab では Shift 単独の keydown が先に届くので、修飾キーだけの押下では状態を変えない。
		if (MODIFIER_KEYS.has(event.key)) return;
		const composingNow =
			isComposing.current || event.nativeEvent.isComposing || event.keyCode === KEY_CODE_COMPOSING;
		// 候補のためのキーは、編集の操作より先に扱う(Esc は、編集欄から抜ける準備にしない)。
		if (!composingNow && handleCompletionKey(event)) {
			// 候補が出る前に押した Esc が、編集欄から抜ける準備になっていたら、取り消す(次の Tab は、字下げ)。
			tabMovesFocus.current = false;
			return;
		}
		if (leavesEditor(event) || composingNow || prepareClipboard(event)) return;
		const binding = bindingForKey(keyInput(event), {
			tableRowIndent: tableRowIndentAt(state.cursor.line),
			mac: IS_MAC,
		});
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
		if (!(target instanceof Element)) return { line: LINE_END, column: LINE_END };
		return cursorFromPoint(target, clientX, clientY, rootRef.current);
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

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: 操作を受け付けるのは中の textarea。ここはマウスでカーソル位置を決めるための領域で、キーボード操作は textarea が受ける。
		<div
			ref={rootRef}
			className="editor"
			data-testid="editor"
			data-focused={focused}
			data-readonly={readOnly || undefined}
			// 読むだけのときは、ブラウザの既定の動作(文字を選ぶ)に任せる。
			onMouseDown={readOnly ? undefined : handleMouseDown}
		>
			{/* 行より前に置く。Tab の順序が「編集欄 → 本文中のリンク」になり、Shift+Tab では編集欄の前へ抜けられる。 */}
			{!readOnly && (
				<textarea
					ref={inputRef}
					className="editor-input"
					aria-label="ページの本文"
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					rows={1}
					aria-autocomplete={completeTitles ? "list" : undefined}
					aria-controls={completion ? completionId : undefined}
					aria-activedescendant={
						completion && completion.active >= 0
							? `${completionId}-${completion.active}`
							: undefined
					}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
					onCopy={copySelection}
					onCut={handleCut}
					onCompositionStart={handleCompositionStart}
					onCompositionUpdate={handleCompositionUpdate}
					onCompositionEnd={handleCompositionEnd}
					onFocus={() => {
						revealCaret.current = true;
						setFocused(true);
					}}
					onBlur={() => setFocused(false)}
				/>
			)}
			{groups.map((group) => {
				const lines = state.lines.slice(group.start, group.end).map((text, offset) => {
					const index = group.start + offset;
					const role = roles[index];
					const isCursorLine = focused && state.cursor.line === index;
					const selected = lineSelection(selection, index, text.length);
					const id = tracker.lines[index]?.id;
					return (
						<EditorLine
							// 行IDで識別する。行が増減したり動いたりしても、同じ行は同じ要素のまま保たれる。
							key={id}
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
							others={id && othersByLine.get(id)}
							missingLinks={missingLinks}
						/>
					);
				});
				if (!group.table) return lines;
				// テーブルの行は1つの枠で囲み、列の幅をそろえる。
				return (
					// テーブルの始まりの行(まとまりの直前の行)で識別する。中の行を並べ替えても、枠は作り直されない。
					<div className="table-block" key={`table-${tracker.lines[group.start - 1]?.id}`}>
						{lines}
					</div>
				);
			})}
			{completion && (
				<CompletionList
					ref={completionRef}
					id={completionId}
					titles={completion.titles}
					active={completion.active}
					onPick={pickTitle}
				/>
			)}
		</div>
	);
}
