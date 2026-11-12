import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "./editor.tsx";

afterEach(cleanup);

const input = () => screen.getByLabelText<HTMLTextAreaElement>("ページの本文");
const lines = () => screen.getAllByTestId("line").map((line) => line.getAttribute("data-text"));

/** カーソルのある行番号と、行内でカーソルより前にある生のテキストの長さ。 */
function caret(): { line: number; column: number } {
	const element = screen.getByTestId("caret");
	const line = element.closest("[data-line]");
	const next = element.nextElementSibling;
	const text = line?.getAttribute("data-text") ?? "";
	return {
		line: Number(line?.getAttribute("data-line")),
		column: next?.hasAttribute("data-column")
			? Number(next.getAttribute("data-column"))
			: text.length,
	};
}

/** 利用者が文字を打ったときにブラウザが行うこと(textarea に値が入り、input が発火する)を再現する。 */
function type(text: string) {
	fireEvent.input(input(), { target: { value: text } });
}

function press(key: string, init: KeyboardEventInit = {}) {
	return fireEvent.keyDown(input(), { key, ...init });
}

/** キーボードで編集欄に入ったときのように、押す操作なしでフォーカスを当てる。 */
function focusEditor() {
	fireEvent.focus(input());
}

function clickChar(lineIndex: number, column: number) {
	const line = screen.getAllByTestId("line")[lineIndex];
	const char = line?.querySelector(`[data-column="${column}"]`);
	if (!char) throw new Error(`no char at line ${lineIndex}, column ${column}`);
	fireEvent.mouseDown(char);
}

describe("Editor", () => {
	describe("表示", () => {
		it("渡された行を表示する。フォーカスするまでカーソルは表示しない", () => {
			render(<Editor initialLines={["タイトル", " 本文"]} />);

			expect(lines()).toEqual(["タイトル", " 本文"]);
			expect(screen.queryByTestId("caret")).toBeNull();
		});

		it("フォーカスすると、カーソルを先頭に表示する", () => {
			render(<Editor initialLines={["タイトル", " 本文"]} />);

			focusEditor();

			expect(caret()).toEqual({ line: 0, column: 0 });
		});

		it("行が1つもなければ、空の1行から始める", () => {
			render(<Editor initialLines={[]} />);

			expect(lines()).toEqual([""]);
		});
	});

	describe("クリック", () => {
		it("文字を押すと、その位置にカーソルが移り、入力を受け付ける状態になる", () => {
			render(<Editor initialLines={["abc", "def"]} />);

			clickChar(1, 2);

			expect(caret()).toEqual({ line: 1, column: 2 });
			expect(document.activeElement).toBe(input());
		});

		it("行の余白を押すと、その行の末尾にカーソルが移る", () => {
			render(<Editor initialLines={["abc", "def"]} />);

			fireEvent.mouseDown(screen.getAllByTestId("line")[1] as HTMLElement);

			expect(caret()).toEqual({ line: 1, column: 3 });
		});

		it("行の外を押すと、最後の行の末尾にカーソルが移る", () => {
			render(<Editor initialLines={["abc", "def"]} />);

			fireEvent.mouseDown(screen.getByTestId("editor"));

			expect(caret()).toEqual({ line: 1, column: 3 });
		});

		it("フォーカスの有無を属性に反映する(カーソルの表示切り替えに使う)", () => {
			render(<Editor initialLines={["abc"]} />);
			expect(screen.getByTestId("editor").getAttribute("data-focused")).toBe("false");

			clickChar(0, 0);
			expect(screen.getByTestId("editor").getAttribute("data-focused")).toBe("true");

			fireEvent.blur(input());
			expect(screen.getByTestId("editor").getAttribute("data-focused")).toBe("false");
		});
	});

	describe("記法の表示", () => {
		const link = () => screen.queryByRole("link", { name: "a" });

		it("カーソルのない行は記法を装飾して表示し、カーソルのある行は記法をそのまま表示する", () => {
			render(<Editor initialLines={["タイトル", "[a]"]} />);
			expect(link()).not.toBeNull();

			fireEvent.mouseDown(screen.getAllByTestId("line")[1] as HTMLElement);

			expect(link()).toBeNull();
			expect(screen.getAllByTestId("line")[1]?.textContent).toBe("[a]");
		});

		it("編集欄からフォーカスが外れると、すべての行を装飾して表示する", () => {
			render(<Editor initialLines={["タイトル", "[a]"]} />);
			fireEvent.mouseDown(screen.getAllByTestId("line")[1] as HTMLElement);

			fireEvent.blur(input());

			expect(link()).not.toBeNull();
			expect(screen.queryByTestId("caret")).toBeNull();
		});

		it("装飾された文字を押すと、生のテキストでの位置にカーソルが入る", () => {
			render(<Editor initialLines={["タイトル", "[* ab]"]} />);

			clickChar(1, 4);

			expect(caret()).toEqual({ line: 1, column: 4 });
		});

		it("リンクを押してもカーソルは動かさず、ブラウザの移動に任せる", () => {
			render(<Editor initialLines={["タイトル", "[a]"]} />);
			const char = link()?.querySelector("[data-column]") as HTMLElement;

			const notPrevented = fireEvent.mouseDown(char);

			expect(notPrevented).toBe(true);
			expect(link()).not.toBeNull();
			expect(document.activeElement).not.toBe(input());
		});
	});

	describe("行のない場所を押したとき", () => {
		it("編集欄の中で行のない場所(テーブルの右など)を押すと、文書の末尾ではなく、押した高さに近い行に入る", () => {
			render(<Editor initialLines={["t", "ab", "cd"]} />);
			const rows = screen.getAllByTestId("line");
			// 仮想DOMでは位置を測れないので、2行目だけが押した高さにあることにする。
			rows.forEach((row, index) => {
				row.getBoundingClientRect = () =>
					({ top: index * 20, bottom: index * 20 + 20, left: 0, width: 0, height: 20 }) as DOMRect;
			});

			fireEvent.mouseDown(screen.getByTestId("editor"), { clientY: 30 });

			expect(caret()).toEqual({ line: 1, column: 2 });
		});
	});

	describe("コードブロックとテーブル", () => {
		const kindsOf = () =>
			screen.getAllByTestId("line").map((element) => element.getAttribute("data-kind"));

		it("行の役割を、ページ全体の並びから決めて表示する", () => {
			render(<Editor initialLines={["t", "code:a.js", " x", "table:b", " 1\t2", "end"]} />);

			expect(kindsOf()).toEqual([
				"title",
				"code-head",
				"code-body",
				"table-head",
				"table-row",
				"text",
			]);
		});

		it("編集で行の並びが変わると、後ろの行の役割も変わる", () => {
			render(<Editor initialLines={["t", "code:a.js", "x"]} />);
			expect(kindsOf()[2]).toBe("text");

			fireEvent.mouseDown(screen.getAllByTestId("line")[2] as HTMLElement);
			press("Tab");

			expect(lines()[2]).toBe(" x");
			expect(kindsOf()[2]).toBe("code-body");
		});

		it("テーブルの行は、列をそろえるための1つの枠にまとめる", () => {
			render(<Editor initialLines={["t", "table:a", " 1\t2", " 3\t4", "end"]} />);

			const rows = screen.getAllByTestId("line").slice(2, 4);
			const block = rows[0]?.closest(".table-block");
			expect(block).not.toBeNull();
			expect(rows[1]?.closest(".table-block")).toBe(block);
			expect(block?.querySelectorAll("[data-testid='line']")).toHaveLength(2);
		});

		it("セルの文字以外のところを押すと、そのセルの末尾にカーソルが入る", () => {
			render(<Editor initialLines={["t", "table:a", " xy\tz"]} />);
			const firstCell = screen
				.getAllByTestId("line")[2]
				?.querySelectorAll(".cell:not(.indent-cell)")[0];

			fireEvent.mouseDown(firstCell as Element);
			type("!");

			expect(lines()[2]).toBe(" xy!\tz");
		});

		it("テーブルの行で Tab を押すと、タブ文字が入って新しいセルができる", () => {
			render(<Editor initialLines={["t", "table:a", " x"]} />);
			clickChar(2, 1);
			press("ArrowRight");

			press("Tab");
			type("y");

			expect(lines()[2]).toBe(" x\ty");
			expect(caret()).toEqual({ line: 2, column: 4 });
		});
	});

	describe("範囲選択", () => {
		const selectedText = () =>
			[...document.querySelectorAll("[data-column].selected")].map((el) => el.textContent).join("");

		it("Shift+矢印で選択を広げ、選択した文字に印が付く", () => {
			render(<Editor initialLines={["abcd"]} />);
			clickChar(0, 1);

			press("ArrowRight", { shiftKey: true });
			press("ArrowRight", { shiftKey: true });

			expect(selectedText()).toBe("bc");
			expect(caret()).toEqual({ line: 0, column: 3 });
		});

		it("選択したまま文字を打つと、選択した範囲と置き換わる", () => {
			render(<Editor initialLines={["abcd"]} />);
			clickChar(0, 1);
			press("ArrowRight", { shiftKey: true });
			press("ArrowRight", { shiftKey: true });

			type("X");

			expect(lines()).toEqual(["aXd"]);
			expect(selectedText()).toBe("");
		});

		it("Ctrl+A ですべてを選択し、Backspace でまとめて消せる", () => {
			render(<Editor initialLines={["ab", "cd"]} />);
			clickChar(0, 0);

			press("a", { ctrlKey: true });
			expect(selectedText()).toBe("abcd");
			expect(document.querySelectorAll(".line-break.selected")).toHaveLength(1);
			press("Backspace");

			expect(lines()).toEqual([""]);
		});

		it("Shift を押しながら別の位置を押すと、そこまでを選択する", () => {
			render(<Editor initialLines={["abcd", "efgh"]} />);
			clickChar(0, 1);

			const target = screen.getAllByTestId("line")[1]?.querySelector('[data-column="2"]');
			fireEvent.mouseDown(target as Element, { shiftKey: true });

			expect(selectedText()).toBe("bcdef");
		});

		it("押したまま動かす(ドラッグ)と、動かした先までを選択する", () => {
			render(<Editor initialLines={["abcd", "efgh"]} />);
			clickChar(0, 1);

			const target = screen.getAllByTestId("line")[1]?.querySelector('[data-column="2"]');
			fireEvent.mouseMove(target as Element, { buttons: 1 });
			expect(selectedText()).toBe("bcdef");

			fireEvent.mouseUp(target as Element);
			fireEvent.mouseMove(screen.getAllByTestId("line")[0] as Element, { buttons: 0 });
			expect(selectedText()).toBe("bcdef");
		});

		it("押してすぐ離しただけなら、選択にはならない", () => {
			render(<Editor initialLines={["abcd"]} />);
			clickChar(0, 1);

			const same = screen.getByTestId("line").querySelector('[data-column="1"]');
			fireEvent.mouseMove(same as Element, { buttons: 1 });
			fireEvent.mouseUp(same as Element);

			expect(selectedText()).toBe("");
		});

		it("編集欄からフォーカスが外れているあいだは、選択を表示しない", () => {
			render(<Editor initialLines={["abcd"]} />);
			clickChar(0, 1);
			press("ArrowRight", { shiftKey: true });

			fireEvent.blur(input());

			expect(selectedText()).toBe("");
		});

		describe("選択したままの日本語入力", () => {
			function selectAndCompose() {
				render(<Editor initialLines={["abcd"]} />);
				clickChar(0, 1);
				press("ArrowRight", { shiftKey: true });
				press("ArrowRight", { shiftKey: true });
				fireEvent.compositionStart(input());
				fireEvent.compositionUpdate(input(), { data: "にほ" });
			}

			it("変換を始めただけでは、選択した範囲は消えない", () => {
				selectAndCompose();

				expect(lines()).toEqual(["abcd"]);
			});

			it("変換を取り消すと、文書も選択も元のまま", () => {
				selectAndCompose();

				fireEvent.compositionEnd(input(), { data: "" });

				expect(lines()).toEqual(["abcd"]);
				expect(selectedText()).toBe("bc");
			});

			it("確定すると選択した範囲と置き換わり、1回の取り消しで選択した状態まで戻る", () => {
				selectAndCompose();
				type("日本");
				fireEvent.compositionEnd(input(), { data: "日本" });
				expect(lines()).toEqual(["a日本d"]);

				press("z", { ctrlKey: true });

				expect(lines()).toEqual(["abcd"]);
				expect(selectedText()).toBe("bc");
			});
		});
	});

	describe("コピーと切り取り", () => {
		function select() {
			render(<Editor initialLines={["ab", " [c]", "de"]} />);
			clickChar(0, 1);
			press("ArrowDown", { shiftKey: true });
			press("ArrowDown", { shiftKey: true });
		}
		const clipboard = () => ({ setData: vi.fn() });

		it("コピーすると、選択した範囲の生のテキストがクリップボードに入る", () => {
			select();
			const clipboardData = clipboard();

			const notPrevented = fireEvent.copy(input(), { clipboardData });

			expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "b\n [c]\nd");
			expect(notPrevented).toBe(false);
			expect(lines()).toEqual(["ab", " [c]", "de"]);
		});

		it("切り取ると、クリップボードに入れたうえで選択した範囲を消す", () => {
			select();
			const clipboardData = clipboard();

			fireEvent.cut(input(), { clipboardData });

			expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "b\n [c]\nd");
			expect(lines()).toEqual(["ae"]);
		});

		it("選択していなければ、コピーも切り取りも何もしない", () => {
			render(<Editor initialLines={["ab"]} />);
			clickChar(0, 1);
			const clipboardData = clipboard();

			fireEvent.copy(input(), { clipboardData });
			fireEvent.cut(input(), { clipboardData });

			expect(clipboardData.setData).not.toHaveBeenCalled();
			expect(lines()).toEqual(["ab"]);
		});

		it("キーの文字が英字にならない配列でも、C の位置のキーでコピーの準備をする", () => {
			select();

			press("с", { ctrlKey: true, code: "KeyC" });

			expect(input().value).toBe("b\n [c]\nd");
		});

		it("Ctrl+C を押した時点で、入力欄に選択した文字列を入れて選択しておく(コピーの操作が確実に届くようにする)", () => {
			select();

			const notPrevented = press("c", { ctrlKey: true });

			expect(notPrevented).toBe(true);
			expect(input().value).toBe("b\n [c]\nd");
			expect(input().selectionStart).toBe(0);
			expect(input().selectionEnd).toBe(input().value.length);
		});

		it("コピーのあと、入力欄は空に戻る(次に打った文字に混ざらない)", () => {
			select();
			press("c", { ctrlKey: true });

			fireEvent.copy(input(), { clipboardData: clipboard() });

			expect(input().value).toBe("");
		});

		it("選択していないときの Ctrl+C では、入力欄に何も入れない", () => {
			render(<Editor initialLines={["ab"]} />);
			clickChar(0, 1);

			press("c", { ctrlKey: true });

			expect(input().value).toBe("");
		});
	});

	describe("取り消しとやり直し", () => {
		it("Ctrl+Z で直前の編集を取り消し、Ctrl+Shift+Z でやり直す", () => {
			render(<Editor initialLines={["ab"]} />);
			fireEvent.mouseDown(screen.getByTestId("line"));
			press("Enter");
			expect(lines()).toEqual(["ab", ""]);

			press("z", { ctrlKey: true });
			expect(lines()).toEqual(["ab"]);
			expect(caret()).toEqual({ line: 0, column: 2 });

			press("Z", { ctrlKey: true, shiftKey: true });
			expect(lines()).toEqual(["ab", ""]);
		});

		it("続けて打った文字は、1回の取り消しでまとめて消える", () => {
			render(<Editor initialLines={["ab"]} />);
			fireEvent.mouseDown(screen.getByTestId("line"));

			type("c");
			type("d");
			press("z", { ctrlKey: true });

			expect(lines()).toEqual(["ab"]);
		});

		it("貼り付けた複数行は、打った文字とは別の単位で取り消せる", () => {
			render(<Editor initialLines={["ab"]} />);
			fireEvent.mouseDown(screen.getByTestId("line"));

			type("c");
			type("x\ny");
			press("z", { ctrlKey: true });

			expect(lines()).toEqual(["abc"]);
		});

		it("取り消しのキーは、ブラウザの既定の動作を止める", () => {
			render(<Editor initialLines={["ab"]} />);

			expect(press("z", { ctrlKey: true })).toBe(false);
		});
	});

	describe("文字入力", () => {
		it("打った文字がカーソル位置に入り、入力欄は空に戻る", () => {
			render(<Editor initialLines={["ac"]} />);
			clickChar(0, 1);

			type("b");

			expect(lines()).toEqual(["abc"]);
			expect(caret()).toEqual({ line: 0, column: 2 });
			expect(input().value).toBe("");
		});

		it("複数行の文字列を貼り付けると、行に分かれて入る", () => {
			render(<Editor initialLines={[""]} />);
			focusEditor();

			type("1行目\n 2行目");

			expect(lines()).toEqual(["1行目", " 2行目"]);
			expect(caret()).toEqual({ line: 1, column: 4 });
		});
	});

	describe("キー操作", () => {
		it("Enter で改行し、インデントを引き継ぐ", () => {
			render(<Editor initialLines={[" item"]} />);
			fireEvent.mouseDown(screen.getByTestId("line"));

			press("Enter");

			expect(lines()).toEqual([" item", " "]);
			expect(caret()).toEqual({ line: 1, column: 1 });
		});

		it("Backspace で直前の文字を消す", () => {
			render(<Editor initialLines={["abc"]} />);
			fireEvent.mouseDown(screen.getByTestId("line"));

			press("Backspace");

			expect(lines()).toEqual(["ab"]);
		});

		it("扱ったキーは、ブラウザの既定の動作を止める", () => {
			render(<Editor initialLines={["abc"]} />);

			const notPrevented = press("Tab");

			expect(notPrevented).toBe(false);
			expect(lines()).toEqual([" abc"]);
		});

		it("キー操作のあと、カーソルが見える位置までスクロールする", () => {
			const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
			render(<Editor initialLines={["abc"]} />);
			clickChar(0, 0);
			scrollIntoView.mockClear();

			press("Enter");

			expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
			expect(scrollIntoView.mock.contexts.at(-1)).toBe(screen.getByTestId("caret"));
		});

		it("フォーカスがないときはスクロールしない", () => {
			const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

			render(<Editor initialLines={["abc"]} />);

			expect(scrollIntoView).not.toHaveBeenCalled();
		});

		it("Esc の直後の Tab はインデントにせず、ブラウザに任せる(キーボードだけで編集欄から抜けられる)", () => {
			render(<Editor initialLines={["abc"]} />);
			clickChar(0, 0);

			press("Escape");
			const tabNotPrevented = press("Tab");
			press("Escape");
			const shiftTabNotPrevented = press("Tab", { shiftKey: true });

			expect(tabNotPrevented).toBe(true);
			expect(shiftTabNotPrevented).toBe(true);
			expect(lines()).toEqual(["abc"]);
		});

		it("Esc のあと Shift を押してから Tab を押しても、編集欄から抜けられる(実際のキー入力の順序)", () => {
			render(<Editor initialLines={["abc"]} />);
			clickChar(0, 0);

			press("Escape");
			press("Shift", { shiftKey: true });
			const notPrevented = press("Tab", { shiftKey: true });

			expect(notPrevented).toBe(true);
			expect(lines()).toEqual(["abc"]);
		});

		it("Esc のあとに別のキーを押したら、Tab は再びインデントになる", () => {
			render(<Editor initialLines={["abc"]} />);
			clickChar(0, 0);

			press("Escape");
			press("ArrowRight");
			const notPrevented = press("Tab");

			expect(notPrevented).toBe(false);
			expect(lines()).toEqual([" abc"]);
		});

		it("扱わないキーは、ブラウザの既定の動作に任せる", () => {
			render(<Editor initialLines={["abc"]} />);

			const notPrevented = press("a");

			expect(notPrevented).toBe(true);
			expect(lines()).toEqual(["abc"]);
		});
	});

	describe("行の識別", () => {
		it("上に行が増えても、元の行は同じ要素のまま下へずれる(行をIDで識別する)", () => {
			render(<Editor initialLines={["題", "本文"]} />);
			const body = screen.getAllByTestId("line")[1];
			clickChar(0, 0);

			press("Enter");

			expect(lines()).toEqual(["", "題", "本文"]);
			expect(screen.getAllByTestId("line")[2]).toBe(body);
		});

		it("行を動かしても、要素は行についていく", () => {
			render(<Editor initialLines={["題", "A", "B"]} />);
			const moved = screen.getAllByTestId("line")[2];
			clickChar(2, 0);

			press("ArrowUp", { ctrlKey: true });

			expect(lines()).toEqual(["題", "B", "A"]);
			expect(screen.getAllByTestId("line")[1]).toBe(moved);
		});
	});

	describe("テーブルの行の識別", () => {
		it("テーブルの先頭の行を動かしても、他の行は同じ要素のまま保たれる", () => {
			render(<Editor initialLines={["題", "table:t", " A", " B"]} />);
			const second = screen.getAllByTestId("line")[3];
			clickChar(2, 0);

			press("ArrowDown", { ctrlKey: true });

			expect(lines()).toEqual(["題", "table:t", " B", " A"]);
			expect(screen.getAllByTestId("line")[2]).toBe(second);
		});
	});

	describe("行とかたまりを動かす", () => {
		const outline = ["題", "A", " a1", "B", " b1"];

		it("Ctrl+上で、カーソルのある行だけを1行上へ動かす。カーソルは行についていく", () => {
			render(<Editor initialLines={outline} />);
			clickChar(3, 0);

			press("ArrowUp", { ctrlKey: true });

			expect(lines()).toEqual(["題", "A", "B", " a1", " b1"]);
			expect(caret()).toEqual({ line: 2, column: 0 });
		});

		it("Alt+上で、行を子の行ごと、上のかたまりと入れ替える", () => {
			render(<Editor initialLines={outline} />);
			clickChar(3, 0);

			const notPrevented = press("ArrowUp", { altKey: true });

			expect(lines()).toEqual(["題", "B", " b1", "A", " a1"]);
			expect(caret()).toEqual({ line: 1, column: 0 });
			// Alt+矢印は、ブラウザでは「戻る」などに使われる。編集欄の中では既定の動作を止める。
			expect(notPrevented).toBe(false);
		});

		it("Alt+右で子の行ごとインデントし、取り消すと1回で元に戻る", () => {
			render(<Editor initialLines={outline} />);
			clickChar(3, 0);

			press("ArrowRight", { altKey: true });
			expect(lines()).toEqual(["題", "A", " a1", " B", "  b1"]);

			press("z", { ctrlKey: true });
			expect(lines()).toEqual(outline);
		});

		it("複数行を選択して Alt+下を押すと、選択した行とその子の行がまとめて動き、選択は保たれる", () => {
			render(<Editor initialLines={["題", "A", " a1", "B", "C"]} />);
			clickChar(1, 0);
			press("ArrowDown", { shiftKey: true });

			press("ArrowDown", { altKey: true });

			expect(lines()).toEqual(["題", "B", "A", " a1", "C"]);
			expect(screen.getAllByTestId("line")[2]?.querySelector(".selected")).not.toBeNull();
		});

		it("Ctrl+End で文書の末尾へ、Ctrl+Home で文書の先頭へ動く", () => {
			render(<Editor initialLines={["ab", "cd", "ef"]} />);
			clickChar(1, 1);

			press("End", { ctrlKey: true });
			expect(caret()).toEqual({ line: 2, column: 2 });

			press("Home", { ctrlKey: true });
			expect(caret()).toEqual({ line: 0, column: 0 });
		});
	});

	describe("日本語入力(IME)", () => {
		it("変換中の文字列はカーソル位置に表示されるが、行にはまだ入らない", () => {
			render(<Editor initialLines={["ab"]} />);
			clickChar(0, 1);

			fireEvent.compositionStart(input());
			fireEvent.compositionUpdate(input(), { data: "にほ" });

			expect(screen.getByTestId("composing").textContent).toBe("にほ");
			expect(lines()).toEqual(["ab"]);
		});

		it("変換中に発火する input では、文字を確定しない", () => {
			render(<Editor initialLines={[""]} />);

			fireEvent.compositionStart(input());
			type("にほ");

			expect(lines()).toEqual([""]);
			expect(input().value).toBe("にほ");
		});

		it("確定すると、確定した文字列が1回だけ入る(input が compositionend より前に来る順序)", () => {
			render(<Editor initialLines={["ab"]} />);
			clickChar(0, 1);

			fireEvent.compositionStart(input());
			fireEvent.compositionUpdate(input(), { data: "にほん" });
			type("日本");
			fireEvent.compositionEnd(input(), { data: "日本" });

			expect(lines()).toEqual(["a日本b"]);
			expect(caret()).toEqual({ line: 0, column: 3 });
			expect(screen.queryByTestId("composing")).toBeNull();
			expect(input().value).toBe("");
		});

		it("確定すると、確定した文字列が1回だけ入る(input が compositionend より後に来る順序)", () => {
			render(<Editor initialLines={[""]} />);

			fireEvent.compositionStart(input());
			input().value = "日本";
			fireEvent.compositionEnd(input(), { data: "日本" });
			fireEvent.input(input());

			expect(lines()).toEqual(["日本"]);
		});

		it("変換を取り消すと、何も入らない", () => {
			render(<Editor initialLines={["ab"]} />);

			fireEvent.compositionStart(input());
			fireEvent.compositionUpdate(input(), { data: "にほ" });
			fireEvent.compositionEnd(input(), { data: "" });

			expect(lines()).toEqual(["ab"]);
			expect(screen.queryByTestId("composing")).toBeNull();
		});

		it("変換中のキー操作は扱わない(変換の確定に使う Enter で改行しない)", () => {
			render(<Editor initialLines={["ab"]} />);

			fireEvent.compositionStart(input());
			const notPrevented = press("Enter", { isComposing: true });

			expect(notPrevented).toBe(true);
			expect(lines()).toEqual(["ab"]);
		});

		it("確定直後に届く keyCode 229 の Enter でも改行しない(Safari の順序)", () => {
			render(<Editor initialLines={["ab"]} />);

			const notPrevented = press("Enter", { keyCode: 229 });

			expect(notPrevented).toBe(true);
			expect(lines()).toEqual(["ab"]);
		});
	});
});
