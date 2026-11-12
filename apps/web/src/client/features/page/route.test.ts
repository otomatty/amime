import { describe, expect, it } from "vitest";
import { pageNameFromPath, titleFromName } from "./route.ts";

describe("pageNameFromPath", () => {
	it("トップ(/)はページではない", () => {
		expect(pageNameFromPath("/")).toBeNull();
	});

	it("パスを復号してページ名にする", () => {
		expect(pageNameFromPath(`/${encodeURIComponent("メモ")}`)).toBe("メモ");
		expect(pageNameFromPath("/a%2Fb")).toBe("a/b");
	});

	it("復号できないパスは、そのままページ名にする", () => {
		expect(pageNameFromPath("/%E3")).toBe("%E3");
	});
});

describe("titleFromName", () => {
	it("アンダースコアを空白に戻す(リンクのURLは空白をアンダースコアにしている)", () => {
		expect(titleFromName("買い物_メモ")).toBe("買い物 メモ");
	});
});
