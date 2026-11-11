import { describe, expect, it } from "vitest";
import { commandForKey, type KeyInput } from "./keymap.ts";
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

describe("commandForKey", () => {
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
		"%s との組み合わせはまだ扱わず、ブラウザに任せる",
		(modifier) => {
			expect(handleKey(base, key("ArrowLeft", { [modifier]: true }))).toBeNull();
		},
	);

	describe("テーブルの行の中", () => {
		const row = state(["t", " ab"], 1, 2);
		const inTableRow = { inTableRow: true };

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

		it("テーブルの行でなければ、Tab はインデントのまま", () => {
			expect(commandForKey(key("Tab"), { inTableRow: false })?.(row)).toEqual(
				state(["t", "  ab"], 1, 3),
			);
		});
	});

	it("Shift+矢印(範囲選択)はまだ扱わない", () => {
		expect(handleKey(base, key("ArrowLeft", { shift: true }))).toBeNull();
	});
});
