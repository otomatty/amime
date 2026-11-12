import { insertText } from "@amime/editor-core";
import type { Line, LineId } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { createModel, type EditorAction, reduceModel } from "./editor-model.ts";

const line = (id: string, text: string): Line => ({ id: id as LineId, text });
const type = (text: string): EditorAction => ({
	type: "edit",
	command: (state) => insertText(state, text),
	group: null,
	at: 0,
});

describe("createModel", () => {
	it("行IDを持たない本文から始めると、行IDを割り当てる", () => {
		const model = createModel({ initialLines: ["題", "本文"] }, "p");

		expect(model.tracker.lines).toEqual([line("p-0", "題"), line("p-1", "本文")]);
		expect(model.present).toEqual({ lines: ["題", "本文"], cursor: { line: 0, column: 0 } });
	});

	it("行IDを持つ文書から始めると、その行IDを使う", () => {
		const document = [line("a", "題"), line("b", "本文")];

		const model = createModel({ initialDocument: document }, "p");

		expect(model.tracker.lines).toBe(document);
		expect(model.present.lines).toEqual(["題", "本文"]);
	});

	it("何も渡されないか、行のない文書を渡されたら、空の1行から始める", () => {
		expect(createModel({}, "p").present.lines).toEqual([""]);
		expect(createModel({ initialDocument: [], initialLines: ["題"] }, "p").tracker.lines).toEqual([
			line("p-0", "題"),
		]);
	});
});

describe("reduceModel", () => {
	const document = [line("a", "題"), line("b", "本文")];
	const start = () => createModel({ initialDocument: document }, "p");

	it("編集すると、本文と行IDの両方が進む", () => {
		const model = reduceModel(createModel({ initialLines: ["題"] }, "p"), type("a\nb"));

		expect(model.tracker.lines).toEqual([line("p-0", "a"), line("p-1", "b題")]);
	});

	it("取り消しとやり直しができる", () => {
		const edited = reduceModel(start(), type("!"));

		const undone = reduceModel(edited, { type: "undo" });
		expect(undone.tracker.lines).toEqual(document);
		expect(reduceModel(undone, { type: "redo" }).present.lines).toEqual(["!題", "本文"]);
	});

	it("文書が変わらない操作では、同じものを返す", () => {
		const model = start();

		expect(reduceModel(model, { type: "undo" })).toBe(model);
	});

	it("外から届いた文書に置き換えても、自分の編集は取り消せる。届いた変更は残る", () => {
		const edited = reduceModel(start(), type("!"));
		const remote = [line("x", "他の人の行"), ...edited.tracker.lines];

		const replaced = reduceModel(edited, { type: "replace", lines: remote });
		expect(replaced.tracker.lines).toBe(remote);
		expect(replaced.present.cursor).toEqual({ line: 1, column: 1 });

		expect(reduceModel(replaced, { type: "undo" }).present.lines).toEqual([
			"他の人の行",
			"題",
			"本文",
		]);
	});
});
