import type { LineRole } from "@amime/parser";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionList, useLinkCompletion } from "./link-completion.tsx";

afterEach(cleanup);

type Search = (query: string) => Promise<readonly string[]>;

/** フックの結果を、画面に書き出して確かめるための部品。 */
function Harness(props: {
	text: string | null;
	column: number;
	line?: string;
	role?: LineRole;
	search?: Search | undefined;
}) {
	const { completion, move, dismiss } = useLinkCompletion({
		text: props.text,
		column: props.column,
		line: props.line ?? "a",
		role: props.role,
		search: props.search,
	});
	return (
		<>
			<output data-testid="state">
				{completion === null
					? "closed"
					: JSON.stringify({ ...completion, link: completion.link.query })}
			</output>
			<button type="button" onClick={() => move(1)}>
				down
			</button>
			<button type="button" onClick={() => move(-1)}>
				up
			</button>
			<button type="button" onClick={dismiss}>
				dismiss
			</button>
		</>
	);
}

const state = () => screen.getByTestId("state").textContent;
const opened = (link: string, titles: string[], active: number) =>
	JSON.stringify({ link, titles, active });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("useLinkCompletion(リンクを書いている途中の、名前の候補)", () => {
	it("リンクを書いている途中なら、入力した名前の一部で候補を探して返す。最初は、どれも選んでいない", async () => {
		const search = vi.fn<Search>(async () => ["買い物", "買い物 メモ"]);

		render(<Harness text="[買い" column={3} search={search} />);

		expect(state()).toBe("closed");
		await waitFor(() => expect(state()).toBe(opened("買い", ["買い物", "買い物 メモ"], -1)));
		expect(search).toHaveBeenCalledExactlyOnceWith("買い");
	});

	it.each([
		["リンクを書いていない", "ただの文", 4],
		["補完の対象にしない行(本文を渡さない)", null, 0],
	])("%sときは、探さない", async (_name, text, column) => {
		const search = vi.fn<Search>(async () => ["買い物"]);

		render(<Harness text={text} column={column} search={search} />);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(search).not.toHaveBeenCalled();
		expect(state()).toBe("closed");
	});

	it("探す方法が渡されていなければ、何もしない", async () => {
		render(<Harness text="[買い" column={3} />);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(state()).toBe("closed");
	});

	it("候補がなければ、閉じたままにする", async () => {
		render(<Harness text="[買い" column={3} search={async () => []} />);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(state()).toBe("closed");
	});

	it("候補を、上下に選び直せる。端まで行くと、反対の端に回る", async () => {
		render(<Harness text="[買い" column={3} search={async () => ["一", "二", "三"]} />);
		await waitFor(() => expect(state()).toBe(opened("買い", ["一", "二", "三"], -1)));

		press("down");
		expect(state()).toBe(opened("買い", ["一", "二", "三"], 0));
		press("up");
		expect(state()).toBe(opened("買い", ["一", "二", "三"], 2));
		press("down");
		expect(state()).toBe(opened("買い", ["一", "二", "三"], 0));
	});

	it("どれも選んでいないときに上へ動かすと、最後の候補を選ぶ", async () => {
		render(<Harness text="[買い" column={3} search={async () => ["一", "二", "三"]} />);
		await waitFor(() => expect(state()).not.toBe("closed"));

		press("up");

		expect(state()).toBe(opened("買い", ["一", "二", "三"], 2));
	});

	it("入力が進んだら、探し直す。前の候補は、新しい候補が届くまで出さない。選んでいた候補は、外す", async () => {
		const search = vi.fn<Search>(async (query) =>
			query === "買い" ? ["買い物", "買い手"] : ["買い物"],
		);
		const { rerender } = render(<Harness text="[買い" column={3} search={search} />);
		await waitFor(() => expect(state()).not.toBe("closed"));
		press("down");

		rerender(<Harness text="[買い物" column={4} search={search} />);

		expect(state()).toBe("closed");
		await waitFor(() => expect(state()).toBe(opened("買い物", ["買い物"], -1)));
	});

	it("リンクから離れて戻ったら、選んでいた候補は外れている(Enter で、意図しない補完をしない)", async () => {
		const search: Search = async () => ["一", "二"];
		const { rerender } = render(<Harness text="[買]" column={2} search={search} />);
		await waitFor(() => expect(state()).not.toBe("closed"));
		press("down");
		expect(state()).toBe(opened("買", ["一", "二"], 0));

		// カーソルを括弧の外へ動かして、戻す。
		rerender(<Harness text="[買]" column={3} search={search} />);
		expect(state()).toBe("closed");
		rerender(<Harness text="[買]" column={2} search={search} />);

		expect(state()).toBe(opened("買", ["一", "二"], -1));
	});

	it("入力を変えて、すぐに戻しても、選んでいた候補は外れている", async () => {
		const search: Search = async () => ["一", "二"];
		const { rerender } = render(<Harness text="[買" column={2} search={search} />);
		await waitFor(() => expect(state()).not.toBe("closed"));
		press("down");

		rerender(<Harness text="[買い" column={3} search={search} />);
		rerender(<Harness text="[買" column={2} search={search} />);

		expect(state()).toBe(opened("買", ["一", "二"], -1));
	});

	it("候補の並びが変わっても(書ける候補が増えた)、選んでいた名前を選んだままにする", async () => {
		// 行の後ろにバッククォートがあるあいだは、「buy` stuff」は書けない(コードになってしまう)。
		const search: Search = async () => ["buy` stuff", "buy"];
		const { rerender } = render(<Harness text="[bu`" column={3} search={search} />);
		await waitFor(() => expect(state()).toBe(opened("bu", ["buy"], -1)));
		press("down");
		expect(state()).toBe(opened("bu", ["buy"], 0));

		// 後ろのバッククォートを消した。入力した名前の一部は、変わっていない。
		rerender(<Harness text="[bu" column={3} search={search} />);

		expect(state()).toBe(opened("bu", ["buy` stuff", "buy"], 1));
	});

	it("あとから届いた、前の入力への応答は使わない", async () => {
		let releaseOld: (titles: readonly string[]) => void = () => {};
		const search: Search = (query) =>
			query === "古"
				? new Promise((resolve) => {
						releaseOld = resolve;
					})
				: Promise.resolve(["新しい候補"]);
		const { rerender } = render(<Harness text="[古" column={2} search={search} />);
		await new Promise((resolve) => setTimeout(resolve, 150));

		rerender(<Harness text="[新" column={2} search={search} />);
		await waitFor(() => expect(state()).toBe(opened("新", ["新しい候補"], -1)));
		await act(async () => releaseOld(["古い候補"]));

		expect(state()).toBe(opened("新", ["新しい候補"], -1));
	});

	it("そのページへのリンクとして書けない名前(括弧を含む、など)は、候補に出さない", async () => {
		const search: Search = async () => ["買い物[仮]", "買い物", "買い物.icon"];

		render(<Harness text="[買い" column={3} search={search} />);

		await waitFor(() => expect(state()).toBe(opened("買い", ["買い物"], -1)));
	});

	it("その行に書くと、リンクとして読まれなくなる名前は、候補に出さない", async () => {
		// 名前の中のバッククォートが、行の後ろのバッククォートと組になって、コードになる。
		const search: Search = async () => ["buy` stuff", "buy"];

		render(<Harness text="[bu] after `" column={3} search={search} />);

		await waitFor(() => expect(state()).toBe(opened("bu", ["buy"], -1)));
	});

	it("書ける候補が1つもなければ、閉じたままにする", async () => {
		render(<Harness text="[買い" column={3} search={async () => ["買い物[仮]"]} />);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(state()).toBe("closed");
	});

	it("テーブルの行では、カーソルのあるセルの中だけを、リンクとして読む", async () => {
		const search = vi.fn<Search>(async () => ["買い物"]);

		const role: LineRole = { kind: "table-row", blockIndent: 0 };

		render(<Harness text={" [買\t別のセル]"} column={3} role={role} search={search} />);

		await waitFor(() => expect(state()).not.toBe("closed"));
		expect(search).toHaveBeenCalledExactlyOnceWith("買");
	});

	it("閉じたリンクを消して、同じ位置に新しいリンクを書いたら、また候補を出す", async () => {
		const search: Search = async () => ["買い物"];
		const { rerender } = render(<Harness text="[買" column={2} search={search} />);
		await waitFor(() => expect(state()).not.toBe("closed"));
		press("dismiss");

		// リンクを消した(リンクを書いている途中でなくなった)。
		rerender(<Harness text="" column={0} search={search} />);
		rerender(<Harness text="[旅" column={2} search={search} />);

		await waitFor(() => expect(state()).toBe(opened("旅", ["買い物"], -1)));
	});

	it("閉じたら、同じリンクを書いているあいだは、候補を出さない。別のリンクを書き始めたら、また出す", async () => {
		const search: Search = async () => ["買い物"];
		const { rerender } = render(<Harness text="[買" column={2} search={search} />);
		await waitFor(() => expect(state()).not.toBe("closed"));

		press("dismiss");
		expect(state()).toBe("closed");
		rerender(<Harness text="[買い" column={3} search={search} />);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(state()).toBe("closed");

		rerender(<Harness text="[買い] と [買" column={9} search={search} />);
		await waitFor(() => expect(state()).toBe(opened("買", ["買い物"], -1)));
	});

	it("探すのに失敗しても、何も起きない(入力は続けられる)", async () => {
		const search: Search = async () => {
			throw new Error("offline");
		};

		render(<Harness text="[買い" column={3} search={search} />);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(state()).toBe("closed");
	});
});

describe("CompletionList(名前の候補の一覧)", () => {
	it("候補を並べ、選んでいる候補に印を付ける", () => {
		render(<CompletionList id="list" titles={["買い物", "旅行"]} active={1} onPick={vi.fn()} />);

		const options = screen.getAllByRole("option");
		expect(screen.getByRole("listbox", { name: "ページの名前の候補" }).id).toBe("list");
		expect(options.map((option) => option.textContent)).toEqual(["買い物", "旅行"]);
		expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
			"false",
			"true",
		]);
		expect(options[1]?.id).toBe("list-1");
	});

	it("選んでいる候補が変わったら、その候補が一覧の見えるところに入るように、スクロールする", () => {
		// 候補が多いと、一覧はスクロールする。フォーカスは編集欄にあるので、自動では見えるところに来ない。
		const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
		const titles = ["買い物", "旅行", "料理"];
		const { rerender } = render(
			<CompletionList id="list" titles={titles} active={-1} onPick={vi.fn()} />,
		);
		expect(scrollIntoView).not.toHaveBeenCalled();

		rerender(<CompletionList id="list" titles={titles} active={2} onPick={vi.fn()} />);

		expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
		expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("option", { name: "料理" }));
		scrollIntoView.mockRestore();
	});

	it("候補を押すと、その名前を知らせる。編集欄のカーソルは動かさない(押したことを、外へ伝えない)", () => {
		const onPick = vi.fn();
		const onOuterMouseDown = vi.fn();
		render(
			// biome-ignore lint/a11y/noStaticElementInteractions: 外側へ伝わらないことを確かめるための要素。
			<div onMouseDown={onOuterMouseDown}>
				<CompletionList id="list" titles={["買い物", "旅行"]} active={-1} onPick={onPick} />
			</div>,
		);

		const picked = fireEvent.mouseDown(screen.getByRole("option", { name: "旅行" }));

		expect(onPick).toHaveBeenCalledExactlyOnceWith("旅行");
		expect(onOuterMouseDown).not.toHaveBeenCalled();
		// 既定の動作(フォーカスの移動)も止める。
		expect(picked).toBe(false);
	});

	/** 内側の幅が 100px(それより右はスクロールバー)の一覧を、押したことを数える要素の中に出す。 */
	function renderScrollable() {
		const onPick = vi.fn();
		const onOuterMouseDown = vi.fn();
		render(
			// biome-ignore lint/a11y/noStaticElementInteractions: 外側へ伝わらないことを確かめるための要素。
			<div onMouseDown={onOuterMouseDown}>
				<CompletionList id="list" titles={["買い物", "旅行"]} active={-1} onPick={onPick} />
			</div>,
		);
		const list = screen.getByRole("listbox");
		Object.defineProperty(list, "clientWidth", { value: 100 });
		return { list, onPick, onOuterMouseDown };
	}

	it("一覧のスクロールバーを押しても、編集欄のカーソルは動かさない。スクロールは、ブラウザに任せる", () => {
		const { list, onPick, onOuterMouseDown } = renderScrollable();

		const allowed = fireEvent.mouseDown(list, { clientX: 104 });

		expect(onOuterMouseDown).not.toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
		// 既定の動作(スクロールバーをつかむ)は止めない。
		expect(allowed).toBe(true);
	});

	it("一覧の余白を押しても、編集欄のカーソルは動かさず、フォーカスも外さない", () => {
		const { list, onPick, onOuterMouseDown } = renderScrollable();

		const allowed = fireEvent.mouseDown(list, { clientX: 2 });

		expect(onOuterMouseDown).not.toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
		expect(allowed).toBe(false);
	});
});
