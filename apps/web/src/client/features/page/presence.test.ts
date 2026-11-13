import type { ClientId, LineId } from "@amime/sync";
import { describe, expect, it, vi } from "vitest";
import { createPresence } from "./presence.ts";

const client = (value: string) => value as ClientId;
const at = (line: string, column: number) => ({ line: line as LineId, column });

function setup() {
	const onChange = vi.fn();
	return { onChange, presence: createPresence(onChange) };
}

describe("createPresence(他の人のカーソルの一覧)", () => {
	it("カーソルの位置が届いたら、一覧に加えて知らせる", () => {
		const { onChange, presence } = setup();

		presence.onCursor(client("bob"), at("a", 2));

		expect(onChange).toHaveBeenLastCalledWith([{ client: "bob", ...at("a", 2) }]);
	});

	it("同じ端末のカーソルは、新しい位置に置き換える", () => {
		const { onChange, presence } = setup();

		presence.onCursor(client("bob"), at("a", 2));
		presence.onCursor(client("bob"), at("b", 0));

		expect(onChange).toHaveBeenLastCalledWith([{ client: "bob", ...at("b", 0) }]);
	});

	it("一覧は、端末の識別子の順に並べる(届いた順で、表示が入れ替わらないように)", () => {
		const { onChange, presence } = setup();

		presence.onCursor(client("carol"), at("a", 1));
		presence.onCursor(client("bob"), at("a", 2));

		expect(onChange).toHaveBeenLastCalledWith([
			{ client: "bob", ...at("a", 2) },
			{ client: "carol", ...at("a", 1) },
		]);
	});

	it("カーソルを出すのをやめた端末と、接続を閉じた端末は、一覧から除く", () => {
		const { onChange, presence } = setup();
		presence.onCursor(client("bob"), at("a", 2));
		presence.onCursor(client("carol"), at("a", 1));

		presence.onCursor(client("bob"), null);
		expect(onChange).toHaveBeenLastCalledWith([{ client: "carol", ...at("a", 1) }]);

		presence.onLeave(client("carol"));
		expect(onChange).toHaveBeenLastCalledWith([]);
	});

	it("一覧にない端末についての知らせでは、知らせない", () => {
		const { onChange, presence } = setup();

		presence.onCursor(client("bob"), null);
		presence.onLeave(client("carol"));

		expect(onChange).not.toHaveBeenCalled();
	});

	it("接続が切れたら、一覧を空にする(切れているあいだの動きは分からない)", () => {
		const { onChange, presence } = setup();
		presence.onCursor(client("bob"), at("a", 2));

		presence.onConnection(false);

		expect(onChange).toHaveBeenLastCalledWith([]);
	});

	it("つながったときと、一覧が空のまま切れたときは、知らせない", () => {
		const { onChange, presence } = setup();

		presence.onConnection(true);
		presence.onConnection(false);

		expect(onChange).not.toHaveBeenCalled();
	});
});
