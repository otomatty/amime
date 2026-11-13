import { describe, expect, it, vi } from "vitest";
import { revoking } from "./revoking.ts";

/** 台帳の代わり。呼ばれた順を、calls に書く。 */
function directory(calls: string[], name: string, operation: number) {
	return {
		revoke: vi.fn(async (subject: string) => {
			calls.push(`${name}.revoke(${subject})`);
			return operation;
		}),
		settle: vi.fn(async (subject: string, started: number, applied: boolean) => {
			calls.push(`${name}.settle(${subject}, ${started}, ${applied})`);
		}),
	};
}

const done = async () => "done";
const always = () => true;

describe("revoking(権限を取り上げる変更)", () => {
	it("変える前に、どの台帳にも覚えさせる。変え終えたら、台帳から返った番号を渡して、終えたことを知らせる", async () => {
		const calls: string[] = [];
		const directories = [directory(calls, "a", 100), directory(calls, "b", 200)];

		const result = await revoking(
			directories,
			"u1",
			async () => {
				calls.push("change");
				return "done";
			},
			always,
		);

		expect(result).toBe("done");
		expect(calls.slice(0, 2).sort()).toEqual(["a.revoke(u1)", "b.revoke(u1)"]);
		expect(calls[2]).toBe("change");
		expect(calls.slice(3).sort()).toEqual(["a.settle(u1, 100, true)", "b.settle(u1, 200, true)"]);
	});

	it("変更が断られたら(権限は変わっていない)、取り上げなかったことを知らせる", async () => {
		const calls: string[] = [];
		const only = directory(calls, "a", 100);

		const result = await revoking(
			[only],
			"u1",
			async () => "refused",
			(value) => value === "done",
		);

		expect(result).toBe("refused");
		expect(only.settle).toHaveBeenCalledWith("u1", 100, false);
	});

	it("覚えさせられなかったら、変えない", async () => {
		const calls: string[] = [];
		const broken = directory(calls, "a", 100);
		broken.revoke.mockRejectedValue(new Error("the directory is down"));
		const change = vi.fn(async () => "done");

		await expect(revoking([broken], "u1", change, always)).rejects.toThrow("the directory is down");

		expect(change).not.toHaveBeenCalled();
	});

	it("どれかの台帳に覚えさせられなかったら、覚えさせられた台帳には、取り上げなかったことを知らせる(途中のものを、残さない)", async () => {
		const calls: string[] = [];
		const [working, broken] = [directory(calls, "a", 100), directory(calls, "b", 200)];
		broken.revoke.mockRejectedValue(new Error("the directory is down"));
		const change = vi.fn(done);

		await expect(revoking([working, broken], "u1", change, always)).rejects.toThrow(
			"the directory is down",
		);

		expect(change).not.toHaveBeenCalled();
		expect(working.settle).toHaveBeenCalledWith("u1", 100, false);
		expect(broken.settle).not.toHaveBeenCalled();
	});

	it("終えたことを知らせるのに失敗しても、変更の結果を返す(先の時刻が残るので、接続は閉じられる)", async () => {
		const calls: string[] = [];
		const [broken, working] = [directory(calls, "a", 100), directory(calls, "b", 200)];
		broken.settle.mockRejectedValue(new Error("the directory is down"));

		expect(await revoking([broken, working], "u1", done, always)).toBe("done");

		expect(working.settle).toHaveBeenCalledWith("u1", 200, true);
	});

	it("変更に失敗したら(変わったかどうか、分からない)、変わったものとして知らせる。失敗は、そのまま伝える", async () => {
		const calls: string[] = [];
		const only = directory(calls, "a", 100);

		const failed = revoking(
			[only],
			"u1",
			async () => {
				throw new Error("the database is down");
			},
			always,
		);

		await expect(failed).rejects.toThrow("the database is down");
		expect(only.settle).toHaveBeenCalledWith("u1", 100, true);
	});
});
