import { afterEach, describe, expect, it } from "vitest";
import { currentProject, parseRoute } from "./route.ts";

afterEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("parseRoute(URLのパスから、表示するものを決める)", () => {
	it("トップ(/)は、プロジェクトの一覧", () => {
		expect(parseRoute("/")).toEqual({ kind: "home" });
		expect(parseRoute("")).toEqual({ kind: "home" });
	});

	it("最初の部分だけなら、そのプロジェクトのトップ(末尾の / は、あってもなくてもよい)", () => {
		expect(parseRoute("/team/")).toEqual({ kind: "project", project: "team" });
		expect(parseRoute("/team")).toEqual({ kind: "project", project: "team" });
	});

	it("プロジェクトの名前は、小文字にそろえる", () => {
		expect(parseRoute("/Team/")).toEqual({ kind: "project", project: "team" });
	});

	it("その先があれば、プロジェクトのページ。パスを復号して、ページの名前にする", () => {
		expect(parseRoute(`/team/${encodeURIComponent("メモ")}`)).toEqual({
			kind: "page",
			project: "team",
			name: "メモ",
		});
		expect(parseRoute("/team/a%2Fb")).toMatchObject({ name: "a/b" });
	});

	it("区切りがさらにあるパスでは、最後の部分をページの名前にする(ページの中のリンクは、同じ階層を指す相対パス)", () => {
		expect(parseRoute("/team/notes/weekly")).toMatchObject({ project: "team", name: "weekly" });
		expect(parseRoute("/team/notes/")).toEqual({ kind: "project", project: "team" });
	});

	it("復号できないパスは、そのまま使う", () => {
		expect(parseRoute("/team/%E3")).toMatchObject({ name: "%E3" });
		expect(parseRoute("/%E3/")).toEqual({ kind: "project", project: "%e3" });
	});
});

describe("parseRoute(アプリが使うパス)", () => {
	it("/settings/プロジェクト は、そのプロジェクトの設定", () => {
		expect(parseRoute("/settings/team")).toEqual({ kind: "settings", project: "team" });
		expect(parseRoute("/settings/Team/")).toEqual({ kind: "settings", project: "team" });
	});

	it("/invite/値 は、招待リンク", () => {
		expect(parseRoute("/invite/abc-DEF_123")).toEqual({ kind: "invite", token: "abc-DEF_123" });
	});

	it.each(["/settings", "/settings/", "/invite", "/invite/"])("%s だけなら、トップ", (path) => {
		expect(parseRoute(path)).toEqual({ kind: "home" });
	});
});

describe("currentProject(この画面で開いているプロジェクト)", () => {
	it("URLの最初の部分を返す。トップでは null", () => {
		window.history.replaceState(null, "", "/?playground");
		expect(currentProject()).toBeNull();
		window.history.replaceState(null, "", "/team/memo?q=1");
		expect(currentProject()).toBe("team");
		window.history.replaceState(null, "", "/team");
		expect(currentProject()).toBe("team");
		window.history.replaceState(null, "", "/settings/team");
		expect(currentProject()).toBe("team");
		window.history.replaceState(null, "", "/invite/abc");
		expect(currentProject()).toBeNull();
	});
});
