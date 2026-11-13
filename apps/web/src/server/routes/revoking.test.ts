import { describe, expect, it, vi } from "vitest";
import { revoking } from "./revoking.ts";

/** 台帳の代わり。呼ばれた順を、calls に書く。 */
function directory(calls: string[], name: string, pending: number) {
	return {
		revoke: vi.fn(async (subject: string) => {
			calls.push(`${name}.revoke(${subject})`);
			return pending;
		}),
		settle: vi.fn(async (subject: string, at: number) => {
			calls.push(`${name}.settle(${subject}, ${at})`);
		}),
	};
}

describe("revoking(権限を取り上げる変更)", () => {
	it("変える前に、どの台帳にも覚えさせる。変え終えたら、台帳から返った値を渡して、時刻を直させる", async () => {
		const calls: string[] = [];
		const directories = [directory(calls, "a", 100), directory(calls, "b", 200)];

		const result = await revoking(directories, "u1", async () => {
			calls.push("change");
			return "done";
		});

		expect(result).toBe("done");
		expect(calls.slice(0, 2).sort()).toEqual(["a.revoke(u1)", "b.revoke(u1)"]);
		expect(calls[2]).toBe("change");
		expect(calls.slice(3).sort()).toEqual(["a.settle(u1, 100)", "b.settle(u1, 200)"]);
	});

	it("覚えさせられなかったら、変えない", async () => {
		const calls: string[] = [];
		const broken = directory(calls, "a", 100);
		broken.revoke.mockRejectedValue(new Error("the directory is down"));
		const change = vi.fn(async () => "done");

		await expect(revoking([broken], "u1", change)).rejects.toThrow("the directory is down");

		expect(change).not.toHaveBeenCalled();
	});

	it("時刻を直させるのに失敗しても、変更の結果を返す(先の時刻が残るので、接続は閉じられる)", async () => {
		const calls: string[] = [];
		const [broken, working] = [directory(calls, "a", 100), directory(calls, "b", 200)];
		broken.settle.mockRejectedValue(new Error("the directory is down"));

		expect(await revoking([broken, working], "u1", async () => "done")).toBe("done");

		expect(working.settle).toHaveBeenCalledWith("u1", 200);
	});

	it("変更に失敗しても、時刻は直させる(変更の失敗は、そのまま伝える)", async () => {
		const calls: string[] = [];
		const only = directory(calls, "a", 100);

		const failed = revoking([only], "u1", async () => {
			throw new Error("the database is down");
		});

		await expect(failed).rejects.toThrow("the database is down");
		expect(only.settle).toHaveBeenCalledWith("u1", 100);
	});
});
