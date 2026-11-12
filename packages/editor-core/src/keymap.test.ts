import { describe, expect, it } from "vitest";
import {
	bindingForKey,
	type Command,
	type KeyContext,
	type KeyInput,
	shortcutLetter,
} from "./keymap.ts";
import type { EditorState } from "./types.ts";

const state = (lines: string[], line: number, column: number): EditorState => ({
	lines,
	cursor: { line, column },
});

const key = (name: string, modifiers: Partial<Omit<KeyInput, "key">> = {}): KeyInput => ({
	key: name,
	shift: false,
	ctrl: false,
	alt: false,
	meta: false,
	...modifiers,
});

/** 割り当てが状態を変える操作なら、その操作を返す。 */
function commandForKey(input: KeyInput, context: KeyContext = {}): Command | null {
	const binding = bindingForKey(input, context);
	return binding?.type === "command" ? binding.command : null;
}

describe("bindingForKey", () => {
	const base = state(["ab", " cd"], 1, 2);
	const handleKey = (target: EditorState, input: KeyInput): EditorState | null =>
		commandForKey(input)?.(target) ?? null;

	it.each([
		["Enter", state(["ab", " c", " d"], 2, 1)],
		["Backspace", state(["ab", " d"], 1, 1)],
		["Delete", state(["ab", " c"], 1, 2)],
		["ArrowLeft", state(["ab", " cd"], 1, 1)],
		["ArrowRight", state(["ab", " cd"], 1, 3)],
		["ArrowUp", state(["ab", " cd"], 0, 2)],
		["ArrowDown", state(["ab", " cd"], 1, 3)],
		["Home", state(["ab", " cd"], 1, 0)],
		["End", state(["ab", " cd"], 1, 3)],
		["Tab", state(["ab", "  cd"], 1, 3)],
	])("%s キーに対応する操作を行う", (name, expected) => {
		expect(handleKey(base, key(name))).toEqual(expected);
	});

	it("Shift+Tab はインデントを浅くする", () => {
		expect(handleKey(base, key("Tab", { shift: true }))).toEqual(state(["ab", "cd"], 1, 1));
	});

	it("Shift+Enter も改行する", () => {
		expect(handleKey(base, key("Enter", { shift: true }))).toEqual(state(["ab", " c", " d"], 2, 1));
	});

	it("文字のキーは扱わない(文字入力は入力イベントで受け取る)", () => {
		expect(handleKey(base, key("a"))).toBeNull();
	});

	it.each(["ctrl", "alt", "meta"] as const)(
		"%s との組み合わせで割り当てのないキーは扱わず、ブラウザに任せる",
		(modifier) => {
			expect(handleKey(base, key("Enter", { [modifier]: true }))).toBeNull();
		},
	);

	describe("アウトライン編集", () => {
		const outline = state(["A", " a1", "B", " b1"], 2, 0);
		const linesAfter = (input: KeyInput, context: KeyContext = {}) =>
			commandForKey(input, context)?.(outline)?.lines;

		it("Ctrl+上下は、カーソルのある行だけを動かす", () => {
			expect(linesAfter(key("ArrowUp", { ctrl: true }))).toEqual(["A", "B", " a1", " b1"]);
			expect(linesAfter(key("ArrowDown", { ctrl: true }))).toEqual(["A", " a1", " b1", "B"]);
		});

		it("Ctrl+左右は、カーソルのある行のインデントを変える", () => {
			expect(linesAfter(key("ArrowRight", { ctrl: true }))).toEqual(["A", " a1", " B", " b1"]);
			expect(commandForKey(key("ArrowLeft", { ctrl: true }))?.(state([" x"], 0, 1))).toEqual(
				state(["x"], 0, 0),
			);
		});

		it("Alt+上下は、行を子の行ごと動かす", () => {
			expect(linesAfter(key("ArrowUp", { alt: true }))).toEqual(["B", " b1", "A", " a1"]);
			expect(
				commandForKey(key("ArrowDown", { alt: true }))?.(state(["A", " a1", "B"], 0, 0)).lines,
			).toEqual(["B", "A", " a1"]);
		});

		it("Alt+左右は、行を子の行ごとインデントする", () => {
			expect(linesAfter(key("ArrowRight", { alt: true }))).toEqual(["A", " a1", " B", "  b1"]);
			expect(
				commandForKey(key("ArrowLeft", { alt: true }))?.(state(["P", " A", "  a1"], 1, 0)).lines,
			).toEqual(["P", "A", " a1"]);
		});

		it("Mac でも、行の操作には Control キーを使う", () => {
			expect(linesAfter(key("ArrowUp", { ctrl: true }), { mac: true })).toEqual([
				"A",
				"B",
				" a1",
				" b1",
			]);
		});

		it("Mac の Option+左右は割り当てない(単語単位の移動のために空けておく)", () => {
			expect(bindingForKey(key("ArrowLeft", { alt: true }), { mac: true })).toBeNull();
			expect(bindingForKey(key("ArrowRight", { alt: true }), { mac: true })).toBeNull();
			expect(linesAfter(key("ArrowUp", { alt: true }), { mac: true })).toEqual([
				"B",
				" b1",
				"A",
				" a1",
			]);
		});

		it.each([
			["Ctrl+Shift+上", key("ArrowUp", { ctrl: true, shift: true })],
			["Alt+Shift+上", key("ArrowUp", { alt: true, shift: true })],
			["Ctrl+Alt+上", key("ArrowUp", { ctrl: true, alt: true })],
			["Alt+Meta+上", key("ArrowUp", { alt: true, meta: true })],
		])("%s のように、ほかの修飾キーが重なった組み合わせは扱わない", (_name, input) => {
			expect(bindingForKey(input)).toBeNull();
			expect(bindingForKey(input, { mac: true })).toBeNull();
		});

		it("取り消しの単位は、ほかの編集とまとめない", () => {
			expect(bindingForKey(key("ArrowUp", { alt: true }))).toMatchObject({
				type: "command",
				group: null,
			});
		});
	});

	describe("文書の先頭・末尾への移動", () => {
		const middle = state(["ab", "cd", "ef"], 1, 1);

		it("Ctrl+Home / Ctrl+End で、文書の先頭と末尾へ動く", () => {
			expect(handleKey(middle, key("Home", { ctrl: true }))).toEqual(
				state(["ab", "cd", "ef"], 0, 0),
			);
			expect(handleKey(middle, key("End", { ctrl: true }))).toEqual(
				state(["ab", "cd", "ef"], 2, 2),
			);
		});

		it("Shift を足すと、そこまでを選択する", () => {
			expect(handleKey(middle, key("End", { ctrl: true, shift: true }))).toEqual({
				lines: ["ab", "cd", "ef"],
				anchor: { line: 1, column: 1 },
				cursor: { line: 2, column: 2 },
			});
		});

		it("Mac では、Command+矢印で文書や行の端へ動く", () => {
			const mac = { mac: true };
			const cursorAfter = (name: string) =>
				commandForKey(key(name, { meta: true }), mac)?.(middle).cursor;

			expect(cursorAfter("ArrowUp")).toEqual({ line: 0, column: 0 });
			expect(cursorAfter("ArrowDown")).toEqual({ line: 2, column: 2 });
			expect(cursorAfter("ArrowLeft")).toEqual({ line: 1, column: 0 });
			expect(cursorAfter("ArrowRight")).toEqual({ line: 1, column: 2 });
			expect(
				commandForKey(key("ArrowUp", { meta: true, shift: true }), mac)?.(middle).anchor,
			).toEqual({ line: 1, column: 1 });
		});

		it("Mac では Ctrl+Home を扱わず、Mac 以外では Meta+矢印を扱わない", () => {
			expect(bindingForKey(key("Home", { ctrl: true }), { mac: true })).toBeNull();
			expect(bindingForKey(key("ArrowUp", { meta: true }))).toBeNull();
		});
	});

	describe("テーブルの行の中", () => {
		const row = state(["t", " ab"], 1, 2);
		const inTableRow = { tableRowIndent: 1 };

		it("Tab はインデントではなく、タブ文字を入れて新しいセルを作る", () => {
			expect(commandForKey(key("Tab"), inTableRow)?.(row)).toEqual(state(["t", " a\tb"], 1, 3));
		});

		it("Shift+Tab は、ほかの行と同じくインデントを浅くする", () => {
			expect(commandForKey(key("Tab", { shift: true }), inTableRow)?.(row)).toEqual(
				state(["t", "ab"], 1, 1),
			);
		});

		it("ほかのキーの働きは変わらない", () => {
			expect(commandForKey(key("Enter"), inTableRow)?.(row)).toEqual(
				state(["t", " a", " b"], 2, 1),
			);
		});

		it("Enter で行を分けたとき、新しい行はテーブルのインデントだけを引き継ぐ(空の先頭セルを巻き込まない)", () => {
			const emptyFirstCell = state(["t", " \ta"], 1, 3);

			expect(commandForKey(key("Enter"), inTableRow)?.(emptyFirstCell)).toEqual(
				state(["t", " \ta", " "], 2, 1),
			);
		});

		it("インデントの途中で Enter を押したら、カーソルより前のぶんだけを引き継ぐ", () => {
			const deep = { tableRowIndent: 2 };

			expect(commandForKey(key("Enter"), deep)?.(state(["t", "  a"], 1, 1))).toEqual(
				state(["t", " ", "  a"], 2, 1),
			);
		});

		it("テーブルの行でなければ、Tab はインデントのまま", () => {
			expect(commandForKey(key("Tab"), { tableRowIndent: null })?.(row)).toEqual(
				state(["t", "  ab"], 1, 3),
			);
		});
	});

	describe("範囲選択", () => {
		const selecting = (anchorColumn: number, line: number, column: number): EditorState => ({
			lines: ["ab", " cd"],
			anchor: { line: 1, column: anchorColumn },
			cursor: { line, column },
		});

		it.each([
			["ArrowLeft", selecting(2, 1, 1)],
			["ArrowRight", selecting(2, 1, 3)],
			["ArrowUp", selecting(2, 0, 2)],
			["Home", selecting(2, 1, 0)],
			["End", selecting(2, 1, 3)],
		])("Shift+%s は、いまの位置を始点にして選択を広げる", (name, expected) => {
			expect(handleKey(base, key(name, { shift: true }))).toEqual(expected);
		});

		it("Shift+ArrowDown は、最後の行では行末まで選択する", () => {
			expect(handleKey(base, key("ArrowDown", { shift: true }))).toEqual(selecting(2, 1, 3));
		});

		it("Ctrl+A は、すべてを選択する", () => {
			expect(handleKey(base, key("a", { ctrl: true }))).toEqual({
				lines: ["ab", " cd"],
				anchor: { line: 0, column: 0 },
				cursor: { line: 1, column: 3 },
			});
		});

		it("テーブルの行で1行の中を選択しているときも、Tab はインデントになる(選択した文字を消さない)", () => {
			const selection: EditorState = {
				lines: ["t", " abc\tdef"],
				anchor: { line: 1, column: 1 },
				cursor: { line: 1, column: 4 },
			};

			expect(commandForKey(key("Tab"), { tableRowIndent: 1 })?.(selection)).toEqual({
				lines: ["t", "  abc\tdef"],
				anchor: { line: 1, column: 2 },
				cursor: { line: 1, column: 5 },
			});
		});

		it("テーブルの行でも、複数行を選択しているときの Tab はインデントになる", () => {
			const selection: EditorState = {
				lines: ["t", " a", " b"],
				anchor: { line: 1, column: 1 },
				cursor: { line: 2, column: 2 },
			};

			expect(commandForKey(key("Tab"), { tableRowIndent: 1 })?.(selection)?.lines).toEqual([
				"t",
				"  a",
				"  b",
			]);
		});
	});

	describe("取り消しとやり直し", () => {
		it("Ctrl+Z は取り消し、Ctrl+Shift+Z と Ctrl+Y はやり直し", () => {
			expect(bindingForKey(key("z", { ctrl: true }))).toEqual({ type: "undo" });
			expect(bindingForKey(key("Z", { ctrl: true, shift: true }))).toEqual({ type: "redo" });
			expect(bindingForKey(key("y", { ctrl: true }))).toEqual({ type: "redo" });
		});
	});

	describe("Mac", () => {
		const mac = { mac: true };

		it("Command キーとの組み合わせを使う", () => {
			expect(bindingForKey(key("z", { meta: true }), mac)).toEqual({ type: "undo" });
			expect(bindingForKey(key("z", { meta: true, shift: true }), mac)).toEqual({ type: "redo" });
			expect(commandForKey(key("a", { meta: true }), mac)?.(base).anchor).toEqual({
				line: 0,
				column: 0,
			});
		});

		it("Command+Y はやり直しにしない(ブラウザに任せる)", () => {
			expect(bindingForKey(key("y", { meta: true }), mac)).toBeNull();
		});

		it("Control キーとの組み合わせは扱わない", () => {
			expect(bindingForKey(key("z", { ctrl: true }), mac)).toBeNull();
			expect(bindingForKey(key("a", { ctrl: true }), mac)).toBeNull();
		});
	});

	describe("英字以外の配列(キーの文字が英字にならない配列)", () => {
		it("キーの位置(code)から英字を求めて、割り当てを決める", () => {
			expect(bindingForKey({ ...key("я", { ctrl: true }), code: "KeyZ" })).toEqual({
				type: "undo",
			});
			expect(bindingForKey({ ...key("ф", { ctrl: true }), code: "KeyA" })?.type).toBe("command");
		});

		it("キーの文字が英字なら、位置ではなく文字で決める(配列を入れ替えている人のため)", () => {
			expect(bindingForKey({ ...key("z", { ctrl: true }), code: "KeyY" })).toEqual({
				type: "undo",
			});
		});

		it("英字のキーでなければ、割り当てはない", () => {
			expect(bindingForKey({ ...key("1", { ctrl: true }), code: "Digit1" })).toBeNull();
			expect(bindingForKey(key("я", { ctrl: true }))).toBeNull();
		});
	});

	describe("shortcutLetter", () => {
		it.each([
			["英字のキー", { ...key("C"), code: "KeyC" }, "c"],
			["英字にならない配列の、C の位置のキー", { ...key("с"), code: "KeyC" }, "c"],
			["英字ではないキー", { ...key("Enter"), code: "Enter" }, null],
			["位置の分からないキー", key("с"), null],
		])("%s", (_name, input, expected) => {
			expect(shortcutLetter(input)).toBe(expected);
		});
	});

	it("Mac 以外では、Meta キーとの組み合わせは扱わない", () => {
		expect(bindingForKey(key("z", { meta: true }))).toBeNull();
	});

	it.each(["c", "x", "v"])(
		"Ctrl+%s(コピー・切り取り・貼り付け)は扱わず、ブラウザに任せる",
		(name) => {
			expect(bindingForKey(key(name, { ctrl: true }))).toBeNull();
		},
	);

	it("Ctrl+Shift+A のような、割り当てのない組み合わせは扱わない", () => {
		expect(bindingForKey(key("A", { ctrl: true, shift: true }))).toBeNull();
	});

	describe("取り消しの単位にまとめる編集の種類", () => {
		const groupOf = (name: string) => {
			const binding = bindingForKey(key(name));
			return binding?.type === "command" ? binding.group : undefined;
		};

		it("Backspace と Delete は、続けて押したぶんをそれぞれ1つにまとめる", () => {
			expect(groupOf("Backspace")).toBe("delete-backward");
			expect(groupOf("Delete")).toBe("delete-forward");
		});

		it.each(["Enter", "Tab", "ArrowLeft"])("%s はまとめない", (name) => {
			expect(groupOf(name)).toBeNull();
		});
	});
});
