import { insertText } from "@amime/editor-core";
import type { Line, LineId } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { createModel, reduceModel } from "./editor-model.ts";

const line = (id: string, text: string): Line => ({ id: id as LineId, text });
const texts = (lines: readonly Line[]) => lines.map((current) => current.text);
const type = (text: string) =>
	({
		type: "edit",
		command: (state: Parameters<typeof insertText>[0]) => insertText(state, text),
		group: null,
		at: 0,
	}) as const;

describe("createModel", () => {
	it("行IDを持たない本文から始めると、行IDを割り当てる", () => {
		const model = createModel({ initialLines: ["題", "本文"] }, "p");

		expect(model.tracker.lines).toEqual([line("p-0", "題"), line("p-1", "本文")]);
		expect(model.history.present).toEqual({
			lines: ["題", "本文"],
			cursor: { line: 0, column: 0 },
		});
	});

	it("行IDを持つ文書から始めると、その行IDを使う", () => {
		const document = [line("a", "題"), line("b", "本文")];

		const model = createModel({ initialDocument: document }, "p");

		expect(model.tracker.lines).toBe(document);
		expect(model.history.present.lines).toEqual(["題", "本文"]);
	});

	it("何も渡されないか、行のない文書を渡されたら、空の1行から始める", () => {
		expect(createModel({}, "p").history.present.lines).toEqual([""]);
		expect(createModel({ initialDocument: [], initialLines: ["題"] }, "p").tracker.lines).toEqual([
			line("p-0", "題"),
		]);
	});
});

describe("reduceModel", () => {
	it("編集すると、本文と行IDの両方が進む", () => {
		const model = reduceModel(createModel({ initialLines: ["題"] }, "p"), type("a\nb"));

		expect(model.tracker.lines).toEqual([line("p-0", "a"), line("p-1", "b題")]);
	});

	it("文書が変わらない操作では、同じものを返す", () => {
		const model = createModel({ initialLines: ["題"] }, "p");

		expect(reduceModel(model, { type: "undo" })).toBe(model);
	});

	describe("replace(他の人の変更を取り込んだ文書への置き換え)", () => {
		const document = [line("a", "題"), line("b", "本文"), line("c", "末尾")];
		const start = () => {
			const model = createModel({ initialDocument: document }, "p");
			// カーソルを「本文」の行の2文字目に置く。
			return reduceModel(model, {
				type: "edit",
				command: (state) => ({ lines: state.lines, cursor: { line: 1, column: 2 } }),
				group: null,
				at: 0,
			});
		};

		it("文書を置き換え、カーソルは同じ行についていく", () => {
			const remote = [line("x", "他の人の行"), ...document];

			const model = reduceModel(start(), { type: "replace", lines: remote, base: document });

			expect(model.tracker.lines).toBe(remote);
			expect(model.history.present).toEqual({
				lines: ["他の人の行", "題", "本文", "末尾"],
				cursor: { line: 2, column: 2 },
			});
		});

		it("選択している範囲も、同じ行についていく", () => {
			const selecting = reduceModel(start(), {
				type: "edit",
				command: (state) => ({
					lines: state.lines,
					anchor: { line: 1, column: 0 },
					cursor: { line: 2, column: 1 },
				}),
				group: null,
				at: 0,
			});
			const remote = [line("x", "他の人の行"), ...document];

			const model = reduceModel(selecting, { type: "replace", lines: remote, base: document });

			expect(model.history.present).toMatchObject({
				anchor: { line: 2, column: 0 },
				cursor: { line: 3, column: 1 },
			});
		});

		it("選択の始点の行が消されていたら、選択をやめる", () => {
			const selecting = reduceModel(start(), {
				type: "edit",
				command: (state) => ({ ...state, anchor: { line: 0, column: 0 } }),
				group: null,
				at: 0,
			});

			const model = reduceModel(selecting, {
				type: "replace",
				lines: document.slice(1),
				base: document,
			});

			expect(model.history.present.anchor).toBeUndefined();
			expect(model.history.present.cursor).toEqual({ line: 0, column: 2 });
		});

		it("カーソルのある行が消されていたら、同じ位置にある行へ移る。列は行の長さに収める", () => {
			const remote = [line("a", "題"), line("c", "末")];

			const model = reduceModel(start(), { type: "replace", lines: remote, base: document });

			expect(model.history.present.cursor).toEqual({ line: 1, column: 1 });
		});

		it("カーソルのあった位置より行が減っていたら、最後の行へ移る", () => {
			const model = reduceModel(start(), {
				type: "replace",
				lines: [line("a", "題")],
				base: document,
			});

			expect(model.history.present.cursor).toEqual({ line: 0, column: 1 });
		});

		it("置き換えの前の状態へは、取り消しで戻らない(他の人の変更を巻き戻さないため)", () => {
			const edited = reduceModel(start(), type("!"));
			const base = edited.tracker.lines;
			const replaced = reduceModel(edited, { type: "replace", lines: base.slice(0, 2), base });

			expect(reduceModel(replaced, { type: "undo" })).toBe(replaced);
		});

		it("取り込みの計算のあとに打った文字があれば、置き換えた文書に載せ直す", () => {
			const typed = reduceModel(start(), type("!"));
			const remote = [line("x", "他の人の行"), ...document];

			// base は、取り込みを計算した時点の文書(「!」を打つ前)。
			const model = reduceModel(typed, { type: "replace", lines: remote, base: document });

			expect(texts(model.tracker.lines)).toEqual(["他の人の行", "題", "本文!", "末尾"]);
			expect(model.history.present.cursor).toEqual({ line: 2, column: 3 });
		});

		it("すべての行が消されていたら、空の1行を置く(編集欄は常に1行以上を持つ)", () => {
			const model = reduceModel(start(), { type: "replace", lines: [], base: document });

			expect(model.history.present).toEqual({ lines: [""], cursor: { line: 0, column: 0 } });
			expect(model.tracker.lines).toEqual([line("p-0", "")]);
		});
	});
});
