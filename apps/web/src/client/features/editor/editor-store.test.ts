import { insertText, setCursor } from "@amime/editor-core";
import type { Line, LineId } from "@amime/sync";
import { describe, expect, it, vi } from "vitest";
import { createModel, type EditorAction } from "./editor-model.ts";
import { createEditorStore } from "./editor-store.ts";

const line = (id: string, text: string): Line => ({ id: id as LineId, text });
const edit = (command: Extract<EditorAction, { type: "edit" }>["command"]): EditorAction => ({
	type: "edit",
	command,
	group: null,
	at: 0,
});

function start() {
	const document = [line("a", "題"), line("b", "本文")];
	const store = createEditorStore(createModel({ initialDocument: document }, "p"));
	const onRender = vi.fn();
	const onEdit = vi.fn();
	store.subscribe(onRender);
	store.onEdit(onEdit);
	return { store, document, onRender, onEdit };
}

describe("createEditorStore", () => {
	it("編集すると、その場で状態が進み、編集後の文書を知らせる", () => {
		const { store, onRender, onEdit } = start();

		store.dispatch(edit((state) => insertText(state, "!")));

		expect(store.getModel().tracker.lines).toEqual([line("a", "!題"), line("b", "本文")]);
		expect(onRender).toHaveBeenCalledOnce();
		expect(onEdit).toHaveBeenCalledExactlyOnceWith(store.getModel().tracker.lines);
	});

	it("カーソルを動かしただけでは、文書が変わったとは知らせない(描き直しはする)", () => {
		const { store, onRender, onEdit } = start();

		store.dispatch(edit((state) => setCursor(state, { line: 1, column: 1 })));

		expect(onRender).toHaveBeenCalledOnce();
		expect(onEdit).not.toHaveBeenCalled();
	});

	it("何も変わらない操作では、何も知らせない", () => {
		const { store, onRender } = start();

		store.dispatch({ type: "undo" });

		expect(onRender).not.toHaveBeenCalled();
	});

	it("外から届いた文書への置き換えは、自分の編集としては知らせない", () => {
		const { store, document, onRender, onEdit } = start();
		const remote = [line("x", "他の人の行"), ...document];

		store.dispatch({ type: "replace", lines: remote });

		expect(store.getModel().tracker.lines).toBe(remote);
		expect(onRender).toHaveBeenCalledOnce();
		expect(onEdit).not.toHaveBeenCalled();
	});

	it("置き換えで文書が補われたら(すべての行が消されて、空の1行を置いたとき)、その文書を知らせる", () => {
		const { store, onEdit } = start();

		store.dispatch({ type: "replace", lines: [] });

		expect(onEdit).toHaveBeenCalledExactlyOnceWith([line("p-0", "")]);
	});

	it("やめた相手には、知らせない", () => {
		const document = [line("a", "題")];
		const store = createEditorStore(createModel({ initialDocument: document }, "p"));
		const onRender = vi.fn();
		const onEdit = vi.fn();
		const stopRender = store.subscribe(onRender);
		const stopEdit = store.onEdit(onEdit);

		stopRender();
		stopEdit();
		store.dispatch(edit((state) => insertText(state, "!")));

		expect(onRender).not.toHaveBeenCalled();
		expect(onEdit).not.toHaveBeenCalled();
	});
});
