import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { PageSummary } from "@amime/parser";
import { type CommitId, type LineId, MAX_LINE_LENGTH, type PageId } from "@amime/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_GROUP_PAGES,
	MAX_LIST_LIMIT,
	MAX_REWRITE_ATTEMPTS,
	MIGRATIONS,
	migrate,
	PLACEHOLDER_MAX_AGE_MS,
	RENAME_MEMORY_MS,
	REWRITE_BATCH,
} from "./project-do.ts";

/** テストごとに別のプロジェクト(=別の Durable Object)を使い、状態を共有しない。 */
const project = (name: string) => exports.ProjectDO.getByName(`test-${name}`);
/** 保存されたページの状態(1行目と、バージョン)。 */
const saved = (title: string, version = 1, summary: Partial<PageSummary> = {}) => ({
	title,
	version,
	updated: 1000 * version,
	summary: { links: [], descriptions: [], image: null, ...summary },
});

describe("ProjectDO(プロジェクトのページの台帳)", () => {
	describe("open(名前からページを引く)", () => {
		it("まだない名前を開くと、新しいIDを決める。名前は、URLの名前から作る", async () => {
			const info = await project("open-new").open("買い物_メモ");

			expect(info).toEqual({
				id: expect.any(String),
				title: "買い物 メモ",
				problem: null,
				pinned: false,
			});
			expect(info.id).toMatch(/^[\w-]{1,64}$/);
		});

		it("同じ名前をもう一度開くと、同じIDになる。大文字小文字と、空白かアンダースコアかの違いは、同じ名前", async () => {
			const stub = project("open-same");
			const first = await stub.open("Page Title");

			expect(await stub.open("Page Title")).toEqual(first);
			expect((await stub.open("page_title")).id).toBe(first.id);
			// 名前の表記は、最初に決めたもののまま。
			expect((await stub.open("PAGE_TITLE")).title).toBe("Page Title");
		});

		it("名前が違えば、別のIDになる", async () => {
			const stub = project("open-other");

			expect((await stub.open("a")).id).not.toBe((await stub.open("b")).id);
		});

		it("IDは、名前から決まる。台帳から消えたあとで同じ名前を開いても、同じIDになる", async () => {
			// 端末内に残した未送信の変更は、IDごとに残っている。IDが変わると、復元できなくなる。
			const stub = project("open-stable");
			const first = await stub.open("出張 メモ");
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("DELETE FROM pages");
			});

			expect((await stub.open("出張_メモ")).id).toBe(first.id);
		});

		it("その名前から決まるIDを、名前を変えた前のページが使っていたら、次のIDにする。これも名前から決まる", async () => {
			const stub = project("open-reused");
			const renamed = await stub.open("名前");
			await stub.index(renamed.id, saved("別の名前"));

			const second = await stub.open("名前");
			expect(second.id).not.toBe(renamed.id);

			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("DELETE FROM pages WHERE id = ?", second.id);
			});
			expect((await stub.open("名前")).id).toBe(second.id);
		});

		it("プロジェクトが違えば、同じ名前でも別のページ", async () => {
			const here = await project("open-here").open("a");
			const there = await project("open-there").open("a");

			expect(here.id).not.toBe(there.id);
		});
	});

	describe("index(ページの名前を、1行目に合わせる)", () => {
		it("1行目が名前と同じなら、名前は変わらない。保存されたページになる", async () => {
			const stub = project("retitle-same");
			const page = await stub.open("メモ");

			expect(await stub.index(page.id, saved("メモ"))).toEqual(page);
		});

		it("表記だけを変えたとき(大文字小文字、空白)は、名前の表記が変わる。IDは変わらない", async () => {
			const stub = project("retitle-case");
			const page = await stub.open("page title");

			expect(await stub.index(page.id, saved("Page_Title"))).toEqual({
				...page,
				title: "Page_Title",
			});
			expect(await stub.open("page title")).toMatchObject({ id: page.id, title: "Page_Title" });
		});

		it("1行目を変えると、ページの名前が変わる。新しい名前で、同じページが開く", async () => {
			const stub = project("retitle-rename");
			const page = await stub.open("旧い名前");
			await stub.index(page.id, saved("旧い名前"));

			const renamed = await stub.index(page.id, saved("新しい名前", 2));

			expect(renamed).toEqual({ id: page.id, title: "新しい名前", problem: null, pinned: false });
			expect((await stub.open("新しい名前")).id).toBe(page.id);
			// 前の名前は空く。開くと、別の新しいページになる。
			expect((await stub.open("旧い名前")).id).not.toBe(page.id);
		});

		it("1行目の前後の空白は、名前に含めない", async () => {
			const stub = project("retitle-trim");
			const page = await stub.open("a");

			expect((await stub.index(page.id, saved("  新しい 名前　"))).title).toBe("新しい 名前");
		});

		it("同じ名前の保存されたページがあれば、名前を変えない。理由を返す", async () => {
			const stub = project("retitle-taken");
			const other = await stub.open("先にある名前");
			await stub.index(other.id, saved("先にある名前"));
			const page = await stub.open("自分の名前");
			await stub.index(page.id, saved("自分の名前"));

			const blocked = await stub.index(page.id, saved("先にある名前", 2));

			expect(blocked).toEqual({
				id: page.id,
				title: "自分の名前",
				problem: "taken",
				pinned: false,
			});
			expect((await stub.open("先にある名前")).id).toBe(other.id);
			expect(await stub.open("自分の名前")).toEqual(blocked);
		});

		it("名前を変えられなかったあとで、空いている名前にすれば変わる", async () => {
			const stub = project("retitle-recover");
			const other = await stub.open("a");
			await stub.index(other.id, saved("a"));
			const page = await stub.open("b");
			await stub.index(page.id, saved("a"));

			expect(await stub.index(page.id, saved("c", 2))).toEqual({
				id: page.id,
				title: "c",
				problem: null,
				pinned: false,
			});
		});

		it("開いただけで保存されていないページの名前は、空いているものとして扱う", async () => {
			const stub = project("retitle-placeholder");
			const placeholder = await stub.open("取りたい名前");
			const page = await stub.open("自分の名前");
			await stub.index(page.id, saved("自分の名前"));

			const renamed = await stub.index(page.id, saved("取りたい名前", 2));

			expect(renamed).toEqual({ id: page.id, title: "取りたい名前", problem: null, pinned: false });
			expect((await stub.open("取りたい名前")).id).toBe(page.id);
			expect(placeholder.id).not.toBe(page.id);
		});

		it("名前を取られたあとで保存されたページは、重ならない名前で台帳に載る", async () => {
			const stub = project("retitle-orphan");
			const placeholder = await stub.open("名前");
			const page = await stub.open("別の名前");
			await stub.index(page.id, saved("名前"));

			// 開いたままだったタブが、あとから書き始めた。
			const adopted = await stub.index(placeholder.id, saved("名前"));

			expect(adopted).toEqual({
				id: placeholder.id,
				title: "名前 (2)",
				problem: "taken",
				pinned: false,
			});
			expect((await stub.open("名前 (2)")).id).toBe(placeholder.id);
			expect((await stub.open("名前")).id).toBe(page.id);
		});

		it("重ならない名前は、番号を付けても、名前の長さの上限に収める", async () => {
			const stub = project("retitle-orphan-long");
			const long = "あ".repeat(200);
			const page = await stub.open(long);
			await stub.index(page.id, saved(long));

			const adopted = await stub.index("unknown-page" as PageId, saved(long));

			expect(adopted.title).toBe(`${"あ".repeat(196)} (2)`);
			expect((await stub.open(adopted.title)).id).toBe("unknown-page");
		});

		it("重ならない名前は、空いている番号を探して決める", async () => {
			const stub = project("retitle-orphan-number");
			for (const title of ["名前", "名前 (2)"]) {
				const page = await stub.open(title);
				await stub.index(page.id, saved(title));
			}

			const adopted = await stub.index("unknown-page" as PageId, saved("名前"));

			expect(adopted.title).toBe("名前 (3)");
		});

		it("台帳にないページの1行目が空なら、「無題」から名前を決める", async () => {
			const adopted = await project("retitle-orphan-empty").index(
				"unknown-page" as PageId,
				saved("  "),
			);

			expect(adopted).toEqual({
				id: "unknown-page",
				title: "無題",
				problem: "empty",
				pinned: false,
			});
		});

		it("1行目が空なら、名前を変えない。理由を返す", async () => {
			const stub = project("retitle-empty");
			const page = await stub.open("名前");

			expect(await stub.index(page.id, saved(" 　"))).toEqual({ ...page, problem: "empty" });
		});

		it.each([["."], [".."]])(
			"1行目が %j なら、名前を変えない(URLにできない)。理由を返す",
			async (title) => {
				const stub = project(`retitle-reserved-${title.length}`);
				const page = await stub.open("名前");

				expect(await stub.index(page.id, saved(title))).toEqual({ ...page, problem: "reserved" });
			},
		);

		it("台帳にないページの1行目が、名前にできないものなら、「無題」から名前を決める", async () => {
			const adopted = await project("retitle-orphan-reserved").index(
				"unknown-page" as PageId,
				saved(".."),
			);

			expect(adopted).toEqual({
				id: "unknown-page",
				title: "無題",
				problem: "reserved",
				pinned: false,
			});
		});

		it("1行目が長すぎるなら、名前を変えない。理由を返す", async () => {
			const stub = project("retitle-long");
			const page = await stub.open("名前");

			expect(await stub.index(page.id, saved("あ".repeat(201)))).toEqual({
				...page,
				problem: "too-long",
			});
			expect((await stub.index(page.id, saved("あ".repeat(200)))).problem).toBeNull();
		});
	});

	describe("開いただけのページの片づけ", () => {
		const backdate = (stub: ReturnType<typeof project>, id: string, age: number) =>
			runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE pages SET created = ? WHERE id = ?", Date.now() - age, id);
			});

		const count = (stub: ReturnType<typeof project>) =>
			runInDurableObject(
				stub,
				(_instance, state) =>
					state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages").one().n,
			);

		it("開いただけで保存されないまま1日たったページは、台帳から消す", async () => {
			const stub = project("gc-old");
			const stale = await stub.open("開いただけ");
			await backdate(stub, stale.id, PLACEHOLDER_MAX_AGE_MS + 1);

			await stub.open("別のページ");

			expect(await count(stub)).toBe(1);
		});

		it("1日たっていないページと、保存されたページは消さない", async () => {
			const stub = project("gc-keep");
			const recent = await stub.open("最近開いた");
			const kept = await stub.open("保存した");
			await stub.index(kept.id, saved("保存した"));
			await backdate(stub, recent.id, PLACEHOLDER_MAX_AGE_MS - 60_000);
			await backdate(stub, kept.id, PLACEHOLDER_MAX_AGE_MS * 30);

			await stub.open("別のページ");

			expect((await stub.open("最近開いた")).id).toBe(recent.id);
			expect((await stub.open("保存した")).id).toBe(kept.id);
		});
	});

	describe("list(ページの一覧)", () => {
		/** 名前と状態を指定して、保存されたページを台帳に載せる。 */
		async function add(
			stub: ReturnType<typeof project>,
			title: string,
			updated: number,
			summary: Partial<PageSummary> = {},
		) {
			const page = await stub.open(title);
			await stub.index(page.id, { ...saved(title, 1, summary), updated });
			return page.id;
		}
		const titles = (list: { pages: readonly { title: string }[] }) =>
			list.pages.map((page) => page.title);

		it("保存されたページを、冒頭の本文・画像・時刻と一緒に返す", async () => {
			const stub = project("list-card");
			const id = await add(stub, "買い物", 5000, {
				descriptions: ["牛乳", "卵"],
				image: "https://example.com/a.png",
			});

			expect(await stub.list({ sort: "updated" })).toEqual({
				pages: [
					{
						id,
						title: "買い物",
						descriptions: ["牛乳", "卵"],
						image: "https://example.com/a.png",
						updated: 5000,
						created: expect.any(Number),
						linked: 0,
						pinned: false,
					},
				],
				total: 1,
			});
		});

		it("開いただけのページは、一覧に出さない", async () => {
			const stub = project("list-placeholder");
			await stub.open("開いただけ");
			await add(stub, "保存した", 1000);

			expect(titles(await stub.list({ sort: "updated" }))).toEqual(["保存した"]);
		});

		it("更新が新しい順に並べる", async () => {
			const stub = project("list-updated");
			await add(stub, "古い", 1000);
			await add(stub, "新しい", 3000);
			await add(stub, "中くらい", 2000);

			expect(titles(await stub.list({ sort: "updated" }))).toEqual(["新しい", "中くらい", "古い"]);
		});

		it("作成が新しい順に並べる", async () => {
			const stub = project("list-created");
			const first = await add(stub, "先に作った", 9000);
			const second = await add(stub, "あとで作った", 1000);
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE pages SET created = 100 WHERE id = ?", first);
				state.storage.sql.exec("UPDATE pages SET created = 200 WHERE id = ?", second);
			});

			expect(titles(await stub.list({ sort: "created" }))).toEqual(["あとで作った", "先に作った"]);
		});

		it("名前の順に並べる(大文字小文字を区別しない)", async () => {
			const stub = project("list-title");
			for (const title of ["banana", "Apple", "cherry"]) await add(stub, title, 1000);

			expect(titles(await stub.list({ sort: "title" }))).toEqual(["Apple", "banana", "cherry"]);
		});

		it("他のページからリンクされている数を数え、多い順に並べる。自分へのリンクは数えない", async () => {
			const stub = project("list-linked");
			await add(stub, "牛乳", 1000, { links: ["牛乳"] });
			await add(stub, "卵", 2000);
			await add(stub, "買い物", 3000, { links: ["牛乳", "卵", "まだないページ"] });
			await add(stub, "献立", 4000, { links: ["Egg", "卵"] });

			const list = await stub.list({ sort: "linked" });

			expect(list.pages.map((page) => [page.title, page.linked])).toEqual([
				["卵", 2],
				["牛乳", 1],
				["献立", 0],
				["買い物", 0],
			]);
		});

		it("ページのリンクが変わったら、数え直す", async () => {
			const stub = project("list-relink");
			await add(stub, "卵", 1000);
			const id = await add(stub, "買い物", 2000, { links: ["卵", "牛乳"] });

			await stub.index(id, saved("買い物", 2, { links: ["牛乳"] }));

			const list = await stub.list({ sort: "title" });
			expect(list.pages.find((page) => page.title === "卵")?.linked).toBe(0);
		});

		it("リンクは、名前の表記の違い(大文字小文字、空白)を同じ名前として数える", async () => {
			const stub = project("list-link-case");
			await add(stub, "Page Title", 1000);
			await add(stub, "他のページ", 2000, { links: ["page_title"] });

			const list = await stub.list({ sort: "linked" });

			expect(list.pages[0]).toMatchObject({ title: "Page Title", linked: 1 });
		});

		it("件数と始まりを指定して、少しずつ取り出せる。総数も返す", async () => {
			const stub = project("list-paging");
			for (const [index, title] of ["a", "b", "c", "d", "e"].entries()) {
				await add(stub, title, 1000 + index);
			}

			const first = await stub.list({ sort: "title", limit: 2 });
			const second = await stub.list({ sort: "title", limit: 2, offset: 2 });
			const last = await stub.list({ sort: "title", limit: 2, offset: 4 });

			expect(titles(first)).toEqual(["a", "b"]);
			expect(titles(second)).toEqual(["c", "d"]);
			expect(titles(last)).toEqual(["e"]);
			expect(first.total).toBe(5);
		});

		it("1度に取り出せる件数には上限がある", async () => {
			const stub = project("list-limit");
			for (let index = 0; index < MAX_LIST_LIMIT + 1; index += 1) {
				await add(stub, `page ${index}`, index);
			}

			const list = await stub.list({ sort: "updated", limit: MAX_LIST_LIMIT * 2 });

			expect(list.pages).toHaveLength(MAX_LIST_LIMIT);
			expect(list.total).toBe(MAX_LIST_LIMIT + 1);
		});
	});

	describe("index(台帳への反映)の途中で失敗したとき", () => {
		it("名前だけが変わって、要約やリンクが古いまま残ることはない(まとめて元に戻る)", async () => {
			const stub = project("index-atomic");
			const page = await stub.open("前の名前");
			await stub.index(page.id, saved("前の名前", 1, { links: ["卵"] }));
			await runInDurableObject(stub, async (instance, state) => {
				// リンクを書き込むところで失敗させる(名前は、その前に書き込まれる)。
				state.storage.sql.exec("ALTER TABLE links RENAME TO links_away");

				await expect(
					instance.index(page.id, saved("新しい名前", 2, { links: ["牛乳"] })),
				).rejects.toThrow();

				state.storage.sql.exec("ALTER TABLE links_away RENAME TO links");
			});

			expect(await stub.open("前の名前")).toMatchObject({ id: page.id, title: "前の名前" });
		});
	});

	describe("pin(一覧の先頭に固定する)", () => {
		const add = async (stub: ReturnType<typeof project>, title: string, updated: number) => {
			const page = await stub.open(title);
			await stub.index(page.id, { ...saved(title), updated });
			return page.id;
		};
		const titles = (list: { pages: readonly { title: string }[] }) =>
			list.pages.map((page) => page.title);

		it("固定したページは、どの並び順でも先頭に並ぶ。あとから固定したものが前", async () => {
			const stub = project("pin-order");
			const old = await add(stub, "古い", 1000);
			await add(stub, "新しい", 3000);
			const middle = await add(stub, "中くらい", 2000);

			expect(await stub.pin(old, true)).toMatchObject({ id: old, pinned: true });
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE pages SET pinned = 1 WHERE id = ?", old);
			});
			await stub.pin(middle, true);

			expect(titles(await stub.list({ sort: "updated" }))).toEqual(["中くらい", "古い", "新しい"]);
			expect(titles(await stub.list({ sort: "title" }))).toEqual(["中くらい", "古い", "新しい"]);
			const list = await stub.list({ sort: "updated" });
			expect(list.pages.map((page) => page.pinned)).toEqual([true, true, false]);
		});

		it("同じ時刻に続けて固定しても、あとから固定したものが前に並ぶ", async () => {
			const stub = project("pin-same-time");
			const newer = await add(stub, "更新が新しい", 3000);
			const older = await add(stub, "更新が古い", 1000);

			// 1回の呼び出しの中では、時刻が進まない。
			await runInDurableObject(stub, (instance) => {
				instance.pin(newer, true);
				instance.pin(older, true);
			});

			expect(titles(await stub.list({ sort: "updated" }))).toEqual(["更新が古い", "更新が新しい"]);
		});

		it("すでに固定しているページを、もう一度固定しても、順は変わらない", async () => {
			const stub = project("pin-again");
			const first = await add(stub, "先に固定", 1000);
			const second = await add(stub, "あとで固定", 2000);
			await runInDurableObject(stub, (instance) => {
				instance.pin(first, true);
				instance.pin(second, true);
				instance.pin(first, true);
			});

			expect(titles(await stub.list({ sort: "title" }))).toEqual(["あとで固定", "先に固定"]);
		});

		it("固定を外すと、ふつうの並びに戻る", async () => {
			const stub = project("pin-off");
			const old = await add(stub, "古い", 1000);
			await add(stub, "新しい", 3000);
			await stub.pin(old, true);

			expect(await stub.pin(old, false)).toMatchObject({ pinned: false });

			expect(titles(await stub.list({ sort: "updated" }))).toEqual(["新しい", "古い"]);
		});

		it("固定しているかどうかは、名前からページを引いたときにも分かる。名前を変えても残る", async () => {
			const stub = project("pin-info");
			const id = await add(stub, "名前", 1000);
			await stub.pin(id, true);

			expect(await stub.open("名前")).toMatchObject({ id, pinned: true });
			expect(await stub.index(id, saved("新しい名前", 2))).toMatchObject({ pinned: true });
		});

		it("台帳にないページは、固定できない", async () => {
			expect(await project("pin-unknown").pin("unknown" as PageId, true)).toBeNull();
		});
	});

	describe("remove(ページを削除する)", () => {
		it("台帳から消す。一覧に出なくなり、そのページからのリンクも数えなくなる", async () => {
			const stub = project("remove-basic");
			const egg = await stub.open("卵");
			await stub.index(egg.id, saved("卵"));
			const shopping = await stub.open("買い物");
			await stub.index(shopping.id, saved("買い物", 1, { links: ["卵"] }));

			await stub.remove(shopping.id);

			const list = await stub.list({ sort: "title" });
			expect(list).toMatchObject({ pages: [{ title: "卵", linked: 0 }], total: 1 });
		});

		it("同じ名前を開くと、別の新しいページになる(削除したページのIDは、使い回さない)", async () => {
			const stub = project("remove-reopen");
			const page = await stub.open("名前");
			await stub.index(page.id, saved("名前"));

			await stub.remove(page.id);

			const reopened = await stub.open("名前");
			expect(reopened.id).not.toBe(page.id);
			// 新しいIDも、名前から決まる。
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("DELETE FROM pages WHERE id = ?", reopened.id);
			});
			expect((await stub.open("名前")).id).toBe(reopened.id);
		});

		it("削除したページについての知らせが届いても、台帳に載せ直さない", async () => {
			const stub = project("remove-late");
			const page = await stub.open("名前");
			await stub.index(page.id, saved("名前"));
			await stub.remove(page.id);

			await stub.index(page.id, saved("名前", 2));

			expect((await stub.list({ sort: "title" })).total).toBe(0);
			expect((await stub.open("名前")).id).not.toBe(page.id);
		});

		it("台帳にないページを削除しても、失敗しない。そのIDは使い回さない", async () => {
			const stub = project("remove-unknown");

			await stub.remove("unknown" as PageId);
			await stub.index("unknown" as PageId, saved("あとから届いた"));

			expect((await stub.list({ sort: "title" })).total).toBe(0);
		});
	});

	describe("links(ページのつながり。ADR-0027)", () => {
		/** 保存されたページを作る。links は、そのページからのリンク先の名前。 */
		async function write(
			stub: ReturnType<typeof project>,
			title: string,
			links: readonly string[] = [],
			version = 1,
		) {
			const { id } = await stub.open(title);
			await stub.index(id, saved(title, version, { links: [...links] }));
			return id;
		}
		const titles = (pages: readonly { title: string }[]) => pages.map((page) => page.title);

		it("リンクしているページと、リンクされているページを、関連するページとして返す。自分は含めない", async () => {
			const stub = project("links-related");
			const here = await write(stub, "ここ", ["行き先", "ここ"]);
			await write(stub, "行き先");
			await write(stub, "ここを 指すページ", ["ここ"]);
			await write(stub, "関係ない ページ", ["どこか"]);

			const links = await stub.links(here);

			expect(titles(links.related).sort()).toEqual(["ここを 指すページ", "行き先"]);
		});

		it("関連するページは、更新が新しい順に並べる。カードには、冒頭の本文とリンクされている数が入る", async () => {
			const stub = project("links-order");
			const here = await write(stub, "ここ", ["古い", "新しい"]);
			await write(stub, "古い", [], 2);
			const newer = await stub.open("新しい");
			await stub.index(newer.id, saved("新しい", 5, { descriptions: ["冒頭"] }));

			const { related } = await stub.links(here);

			expect(titles(related)).toEqual(["新しい", "古い"]);
			expect(related[0]).toMatchObject({ id: newer.id, descriptions: ["冒頭"], linked: 1 });
		});

		it("リンク先の名前は、大文字小文字と、空白かアンダースコアかの違いを区別しない", async () => {
			const stub = project("links-normalized");
			const here = await write(stub, "Here Page", ["target_page"]);
			await write(stub, "Target Page", ["here_page"]);

			const links = await stub.links(here);

			expect(titles(links.related)).toEqual(["Target Page"]);
			expect(links.missing).toEqual([]);
		});

		it("まだないページへのリンクを、正規化した名前で返す。開いただけのページも、まだないページ", async () => {
			const stub = project("links-missing");
			const here = await write(stub, "ここ", ["ある ページ", "まだない Page", "開いただけ"]);
			await write(stub, "ある ページ");
			await stub.open("開いただけ");

			const links = await stub.links(here);

			expect([...links.missing].sort()).toEqual(["まだない_page", "開いただけ"]);
		});

		it("同じリンクを持つ他のページを、リンク先ごとにまとめて返す(2ホップ先)", async () => {
			const stub = project("links-hops");
			const here = await write(stub, "ここ", ["料理", "旅行", "だれも書いていない"]);
			await write(stub, "料理");
			await write(stub, "カレー", ["料理"], 2);
			await write(stub, "パスタ", ["料理"], 3);
			await write(stub, "京都", ["旅行"]);

			const { hops } = await stub.links(here);

			expect(hops.map((group) => [group.title, group.exists, titles(group.pages)])).toEqual([
				// まとまりの中は、更新が新しい順。同じリンクを持つページがないリンク先は、出さない。
				["料理", true, ["パスタ", "カレー"]],
				["旅行", false, ["京都"]],
			]);
		});

		it("まだないページへのリンクのまとまりには、書かれたとおりの名前を付ける", async () => {
			const stub = project("links-hops-title");
			const here = await write(stub, "ここ", ["Road Trip"]);
			await write(stub, "別のページ", ["road_trip"]);

			const { hops } = await stub.links(here);

			expect(hops.map((group) => group.title)).toEqual(["Road Trip"]);
		});

		it("書かれたとおりの名前を持たないリンク(前の形で保存したもの)には、正規化した名前から作った名前を付ける", async () => {
			const stub = project("links-hops-legacy");
			const here = await write(stub, "ここ", ["Road Trip"]);
			await write(stub, "別のページ", ["road_trip"]);
			await runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec("UPDATE links SET title = ''");
			});

			const { hops } = await stub.links(here);

			expect(hops.map((group) => group.title)).toEqual(["road trip"]);
		});

		it("リンクの書き方だけを変えたら(大文字小文字など)、まとまりの名前も変わる", async () => {
			const stub = project("links-hops-rewritten");
			const here = await write(stub, "ここ", ["road trip"]);
			await write(stub, "別のページ", ["road_trip"]);

			await stub.index(here, saved("ここ", 2, { links: ["Road Trip"] }));

			expect((await stub.links(here)).hops.map((group) => group.title)).toEqual(["Road Trip"]);
		});

		it("リンク先のページそのものは、2ホップ先のまとまりに入れない(関連するページに出ている)", async () => {
			const stub = project("links-hops-self");
			const here = await write(stub, "ここ", ["料理"]);
			await write(stub, "料理", ["料理"]);

			const links = await stub.links(here);

			expect(titles(links.related)).toEqual(["料理"]);
			expect(links.hops).toEqual([]);
		});

		it("1つのまとまりに入れるページは、20件まで", async () => {
			const stub = project("links-hops-limit");
			const here = await write(stub, "ここ", ["人気"]);
			for (let number = 0; number < 22; number += 1) {
				await write(stub, `ページ${number}`, ["人気"], number + 1);
			}

			const { hops } = await stub.links(here);

			expect(hops[0]?.pages).toHaveLength(MAX_GROUP_PAGES);
			expect(hops[0]?.pages[0]?.title).toBe("ページ21");
		});

		it("まだ保存されていないページでも、その名前へリンクしているページを返す", async () => {
			// まだないページへのリンクを開いたとき、どこから参照されているかが分かる。
			const stub = project("links-placeholder");
			const { id } = await stub.open("これから 書く");
			await write(stub, "参照元", ["これから_書く"]);

			const links = await stub.links(id);

			expect(titles(links.related)).toEqual(["参照元"]);
			expect(links).toMatchObject({ missing: [], hops: [] });
		});

		it("リンクを消すと、つながりからも消える。台帳にないページには、つながりがない", async () => {
			const stub = project("links-removed");
			const here = await write(stub, "ここ", ["行き先"]);
			await write(stub, "行き先");
			await stub.index(here, saved("ここ", 2));

			expect(await stub.links(here)).toEqual({ missing: [], related: [], hops: [] });
			expect(await stub.links("unknown" as PageId)).toEqual({ missing: [], related: [], hops: [] });
		});
	});

	describe("名前を変えたときの、リンクの書き換え(ADR-0028)", () => {
		let serial = 0;
		const nextCommit = () => {
			serial += 1;
			return `rewrite-${serial}` as CommitId;
		};
		const pageOf = (name: string, id: PageId) => exports.PageDO.getByName(`test-${name}/${id}`);
		/** 本文のあるページを保存する。台帳には、まだ反映しない。 */
		async function save(name: string, title: string, ...body: string[]) {
			const { id } = await project(name).open(title);
			const lines = [title, ...body].map((text, index) => ({ id: `l${index}` as LineId, text }));
			await pageOf(name, id).commit({
				id: nextCommit(),
				changes: lines.map((line, index) => ({
					type: "insert",
					line,
					after: lines[index - 1]?.id ?? null,
					before: null,
				})),
			});
			return id;
		}
		/** 本文のあるページを作り、台帳に反映する。 */
		async function write(name: string, title: string, ...body: string[]) {
			const id = await save(name, title, ...body);
			await runDurableObjectAlarm(pageOf(name, id));
			return id;
		}
		/** ページの1行目を書き換えて(名前を変えて)、台帳に反映する。 */
		async function retitle(name: string, id: PageId, title: string) {
			await pageOf(name, id).commit({
				id: nextCommit(),
				changes: [{ type: "update", id: "l0" as LineId, text: title }],
			});
			await runDurableObjectAlarm(pageOf(name, id));
		}
		const textsOf = async (name: string, id: PageId) => {
			const page = await pageOf(name, id).getPage();
			return page === "deleted" ? [] : page.lines.map((line) => line.text);
		};
		/** 台帳に残っている、まだ済んでいない書き換えの数。 */
		const queued = (name: string) =>
			runInDurableObject(
				project(name),
				(_instance, state) =>
					state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rewrites").one().n,
			);
		/** 台帳の、書き換えのアラームを動かす。予約されていなければ false。 */
		const rewrite = (name: string) => runDurableObjectAlarm(project(name));
		/**
		 * 指定したページの書き換えの前に、割り込む。before が例外を出せば、書き換えは失敗する。
		 * 外から呼べるのは、クラスに定義したメソッドだけなので、クラスの側を差し替える。
		 */
		async function intercept(name: string, id: PageId, before: (call: number) => Promise<void>) {
			await runInDurableObject(pageOf(name, id), (instance) => {
				const prototype = Object.getPrototypeOf(instance) as typeof instance;
				const original = prototype.rewriteLinks;
				let calls = 0;
				vi.spyOn(prototype, "rewriteLinks").mockImplementation(async function (
					this: typeof instance,
					renames,
				) {
					if (this === instance) {
						calls += 1;
						await before(calls);
					}
					return original.call(this, renames);
				});
			});
		}
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("名前を変えると、そのページへリンクしているページの本文が、新しい名前に書き換わる", async () => {
			const name = "rw-basic";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳] を買う", "#牛乳 と [卵]");

			await retitle(name, milk, "豆乳");
			expect(await rewrite(name)).toBe(true);

			expect(await textsOf(name, list)).toEqual(["買い物", "[豆乳] を買う", "#豆乳 と [卵]"]);
			expect(await queued(name)).toBe(0);
			// つながりも、書き換えたページの反映を待たずに、新しい名前になる。
			const links = await project(name).links(list);
			expect(links.related.map((page) => page.title)).toEqual(["豆乳"]);
			expect(links.missing).toEqual(["卵"]);
		});

		it("自分自身へのリンクも、書き換える", async () => {
			const name = "rw-self";
			const milk = await write(name, "牛乳", "[牛乳] は、このページ");

			await retitle(name, milk, "豆乳");
			await rewrite(name);

			expect(await textsOf(name, milk)).toEqual(["豆乳", "[豆乳] は、このページ"]);
		});

		it("大文字小文字と、空白かアンダースコアかの違いだけの変更では、書き換えない(同じ名前として読める)", async () => {
			const name = "rw-same";
			const tea = await write(name, "Milk Tea");
			const list = await write(name, "買い物", "[Milk Tea]");

			await retitle(name, tea, "milk_tea");

			expect(await rewrite(name)).toBe(false);
			expect(await textsOf(name, list)).toEqual(["買い物", "[Milk Tea]"]);
		});

		it("同じ名前のページがあって名前を変えられなかったときは、書き換えない", async () => {
			const name = "rw-taken";
			const milk = await write(name, "牛乳");
			await write(name, "豆乳");
			const list = await write(name, "買い物", "[牛乳]");

			await retitle(name, milk, "豆乳");

			expect(await rewrite(name)).toBe(false);
			expect(await textsOf(name, list)).toEqual(["買い物", "[牛乳]"]);
		});

		it("開いただけだったページに、別の名前を付けて保存しても、書き換えない(前の名前のページは、なかった)", async () => {
			const name = "rw-placeholder";
			const list = await write(name, "買い物", "[仮の名前]");
			const { id } = await project(name).open("仮の名前");

			await project(name).index(id, saved("本当の名前"));

			expect(await rewrite(name)).toBe(false);
			expect(await textsOf(name, list)).toEqual(["買い物", "[仮の名前]"]);
		});

		it("書き換える前に、もう1度名前を変えたら、最後の名前に書き換える", async () => {
			const name = "rw-chain-before";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");

			await retitle(name, milk, "豆乳");
			await retitle(name, milk, "オーツ");
			await rewrite(name);

			expect(await textsOf(name, list)).toEqual(["買い物", "[オーツ]"]);
			expect(await queued(name)).toBe(0);
		});

		it("書き換えた直後(書き換えたページの反映の前)に、もう1度名前を変えても、最後の名前に書き換える", async () => {
			const name = "rw-chain-after";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");
			await retitle(name, milk, "豆乳");
			await rewrite(name);

			await retitle(name, milk, "オーツ");
			await rewrite(name);

			expect(await textsOf(name, list)).toEqual(["買い物", "[オーツ]"]);
		});

		it("書き換えているあいだに、もう1度名前が変わったら、続けて、いまの名前に書き換える", async () => {
			const name = "rw-chain-during";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");
			await retitle(name, milk, "豆乳");
			await intercept(name, list, async (call) => {
				// 書き換えの最中に、もう1度名前が変わる。
				if (call === 1) await project(name).index(milk, saved("オーツ", 3));
			});

			await rewrite(name);
			expect(await textsOf(name, list)).toEqual(["買い物", "[豆乳]"]);
			await rewrite(name);

			expect(await textsOf(name, list)).toEqual(["買い物", "[オーツ]"]);
			expect(await queued(name)).toBe(0);
		});

		it("一部の行だけを書き換えられたページも、そのあとの名前の変更で、見つけて書き換える", async () => {
			const name = "rw-partial";
			const milk = await write(name, "牛乳");
			// 2行目は、書き換えると長さの上限を超える。
			const long = `[牛乳]${"あ".repeat(MAX_LINE_LENGTH - 4)}`;
			const list = await write(name, "買い物", "[牛乳] を買う", long);
			await retitle(name, milk, "豆乳ヨーグルト");
			await rewrite(name);
			expect(await textsOf(name, list)).toEqual(["買い物", "[豆乳ヨーグルト] を買う", long]);

			// 書き換えたページの反映より先に、もう1度名前が変わる。
			await retitle(name, milk, "オーツ");
			await rewrite(name);

			expect((await textsOf(name, list))[1]).toBe("[オーツ] を買う");
		});

		it("書き換えるリンクがもうなかったページを、新しい名前へリンクしていることにしない", async () => {
			const name = "rw-stale";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");
			// リンクを消した。台帳には、まだ反映していない(台帳は、リンクがあると思っている)。
			await pageOf(name, list).commit({
				id: nextCommit(),
				changes: [{ type: "update", id: "l1" as LineId, text: "リンクは消した" }],
			});

			await retitle(name, milk, "豆乳");
			await rewrite(name);

			expect((await project(name).links(list)).related).toEqual([]);
		});

		describe("リンクを書いたページの反映より先に、リンク先の名前が変わったとき", () => {
			it("あとから反映されたリンクも、新しい名前に書き換える", async () => {
				const name = "rw-late";
				const milk = await write(name, "牛乳");
				const list = await save(name, "買い物", "[牛乳] を買う");

				await retitle(name, milk, "豆乳");
				// 台帳は、まだ「買い物」のリンクを知らない。
				expect(await rewrite(name)).toBe(false);
				await runDurableObjectAlarm(pageOf(name, list));

				expect(await rewrite(name)).toBe(true);
				expect(await textsOf(name, list)).toEqual(["買い物", "[豆乳] を買う"]);
			});

			it("続けて名前が変わっていたら、いまの名前に書き換える", async () => {
				const name = "rw-late-chain";
				const milk = await write(name, "牛乳");
				const list = await save(name, "買い物", "[牛乳]");
				await retitle(name, milk, "豆乳");
				await retitle(name, milk, "オーツ");

				await runDurableObjectAlarm(pageOf(name, list));
				await rewrite(name);

				expect(await textsOf(name, list)).toEqual(["買い物", "[オーツ]"]);
			});

			it("名前を元に戻していたら、元の名前へのリンクは、そのままにする", async () => {
				const name = "rw-late-back";
				const milk = await write(name, "牛乳");
				const list = await save(name, "買い物", "[牛乳] と [豆乳]");
				await retitle(name, milk, "豆乳");
				await retitle(name, milk, "牛乳");

				await runDurableObjectAlarm(pageOf(name, list));
				await rewrite(name);

				// 途中の名前へのリンクは、いまの名前に書き換える。
				expect(await textsOf(name, list)).toEqual(["買い物", "[牛乳] と [牛乳]"]);
			});

			it("前の名前で、新しいページができていたら、書き換えない(そのページへのリンクとして読む)", async () => {
				const name = "rw-late-taken";
				const milk = await write(name, "牛乳");
				await retitle(name, milk, "豆乳");
				await write(name, "牛乳", "新しく作った");

				const list = await write(name, "買い物", "[牛乳]");

				expect(await rewrite(name)).toBe(false);
				expect(await textsOf(name, list)).toEqual(["買い物", "[牛乳]"]);
			});

			it("名前を変えてから時間がたったあとに書いたリンクは、書き換えない(まだないページへのリンクとして残す)", async () => {
				const name = "rw-late-old";
				const milk = await write(name, "牛乳");
				await retitle(name, milk, "豆乳");
				await runInDurableObject(project(name), (_instance, state) => {
					state.storage.sql.exec("UPDATE renames SET at = ?", Date.now() - RENAME_MEMORY_MS - 1);
				});

				const list = await write(name, "買い物", "[牛乳]");

				expect(await rewrite(name)).toBe(false);
				expect(await textsOf(name, list)).toEqual(["買い物", "[牛乳]"]);
			});

			it("もう台帳が知っているリンクは、反映のたびに書き換えの予定に入れ直さない", async () => {
				// 書けない名前に変わったので、リンクは前の名前のまま残る。
				const name = "rw-late-known";
				const milk = await write(name, "牛乳");
				const list = await write(name, "買い物", "[牛乳]");
				await retitle(name, milk, "a]b");
				await rewrite(name);
				expect(await queued(name)).toBe(0);

				// 他の行を書き換えて、もう1度反映する。
				await pageOf(name, list).commit({
					id: nextCommit(),
					changes: [
						{
							type: "insert",
							line: { id: "l9" as LineId, text: "追記" },
							after: "l1" as LineId,
							before: null,
						},
					],
				});
				await runDurableObjectAlarm(pageOf(name, list));

				expect(await queued(name)).toBe(0);
			});
		});

		it("2つのページの名前を入れ替えても、それぞれへのリンクは、行き先を保つ", async () => {
			const name = "rw-swap";
			const first = await write(name, "A");
			const second = await write(name, "B");
			const list = await write(name, "一覧", "[A] と [B]");

			// 仮の名前をはさんで、入れ替える。
			await retitle(name, first, "仮");
			await retitle(name, second, "A");
			await retitle(name, first, "B");
			await rewrite(name);

			// 「A」だったページは、いま「B」。「B」だったページは、いま「A」。
			expect(await textsOf(name, list)).toEqual(["一覧", "[B] と [A]"]);
			expect(await queued(name)).toBe(0);
			const links = await project(name).links(list);
			expect(links.related.map((page) => page.id).sort()).toEqual([first, second].sort());
		});

		it("名前を入れ替えたページの書き換えが、保存のあとで失敗して、やり直されても、リンクは行き先を保つ", async () => {
			const name = "rw-swap-retry";
			const first = await write(name, "A");
			const second = await write(name, "B");
			const list = await write(name, "一覧", "[A] と [B]");
			await retitle(name, first, "仮");
			await retitle(name, second, "A");
			await retitle(name, first, "B");
			// 書き換えは保存されるが、そのあとの、台帳への知らせの予約に失敗する。
			await runInDurableObject(pageOf(name, list), (_instance, state) => {
				vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm failed"));
			});

			await rewrite(name);
			expect(await queued(name)).toBe(2);
			await rewrite(name);

			// 2度書き換えると、元に戻ってしまう。1度だけ書き換わっている。
			expect(await textsOf(name, list)).toEqual(["一覧", "[B] と [A]"]);
			expect(await queued(name)).toBe(0);
		});

		it("書き換えの予定を入れたあとで、アラームの予約に失敗していたら、反映のやり直しのときに予約し直す", async () => {
			const name = "rw-reschedule";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");
			const renamed = saved("豆乳", 2);
			await runInDurableObject(project(name), async (instance, state) => {
				vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm failed"));
				await expect(instance.index(milk, renamed)).rejects.toThrow();
			});
			expect(await queued(name)).toBe(1);

			// PageDO は、同じ内容で、反映をやり直す。名前は、もう変わっている。
			await project(name).index(milk, renamed);

			expect(await rewrite(name)).toBe(true);
			expect(await textsOf(name, list)).toEqual(["買い物", "[豆乳]"]);
		});

		it("一部の行だけを書き換えているあいだに、もう1度名前が変わったら、書き換えた行も、残った行も、いまの名前にする", async () => {
			const name = "rw-partial-during";
			const milk = await write(name, "牛乳");
			// 2行目は、長い名前に書き換えると、長さの上限を超える。
			const rest = "あ".repeat(MAX_LINE_LENGTH - 4);
			const list = await write(name, "買い物", "[牛乳] を買う", `[牛乳]${rest}`);
			await retitle(name, milk, "豆乳ヨーグルト");
			await intercept(name, list, async (call) => {
				// 書き換えの最中に、短い名前に変わる。
				if (call === 1) await project(name).index(milk, saved("麦", 3));
			});

			await rewrite(name);
			await rewrite(name);

			expect(await textsOf(name, list)).toEqual(["買い物", "[麦] を買う", `[麦]${rest}`]);
			expect(await queued(name)).toBe(0);
		});

		it("書き換えに失敗したら、あとでやり直す", async () => {
			const name = "rw-retry";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");
			await intercept(name, list, async (call) => {
				if (call === 1) throw new Error("rewrite failed");
			});
			await retitle(name, milk, "豆乳");

			await rewrite(name);
			expect(await textsOf(name, list)).toEqual(["買い物", "[牛乳]"]);
			expect(await queued(name)).toBe(1);

			// やり直しが予約されている。
			expect(await rewrite(name)).toBe(true);
			expect(await textsOf(name, list)).toEqual(["買い物", "[豆乳]"]);
			expect(await queued(name)).toBe(0);
		});

		it("何度やり直しても失敗する書き換えは、あきらめる。他のページの書き換えは止めない", async () => {
			const name = "rw-give-up";
			const milk = await write(name, "牛乳");
			const broken = await write(name, "壊れた", "[牛乳]");
			const fine = await write(name, "無事", "[牛乳]");
			await intercept(name, broken, async () => {
				throw new Error("rewrite failed");
			});
			await retitle(name, milk, "豆乳");

			await rewrite(name);
			expect(await textsOf(name, fine)).toEqual(["無事", "[豆乳]"]);
			for (let attempt = 1; attempt < MAX_REWRITE_ATTEMPTS; attempt += 1) {
				expect(await queued(name)).toBe(1);
				await rewrite(name);
			}

			expect(await queued(name)).toBe(0);
			expect(await rewrite(name)).toBe(false);
		});

		it("1度に書き換えるページの数には、上限がある。残りは、続けて書き換える", async () => {
			const name = "rw-batch";
			await runInDurableObject(project(name), async (_instance, state) => {
				for (let number = 0; number < REWRITE_BATCH + 3; number += 1) {
					state.storage.sql.exec(
						"INSERT INTO rewrites (page_id, old_lc, new_lc, new_title) VALUES (?, '牛乳', '豆乳', '豆乳')",
						`batch-${number}`,
					);
				}
				await state.storage.setAlarm(Date.now());
			});

			await rewrite(name);
			expect(await queued(name)).toBe(3);

			expect(await rewrite(name)).toBe(true);
			expect(await queued(name)).toBe(0);
			expect(await rewrite(name)).toBe(false);
		});

		it("削除したページの書き換えは、取りやめる", async () => {
			const name = "rw-removed";
			const milk = await write(name, "牛乳");
			const list = await write(name, "買い物", "[牛乳]");
			await retitle(name, milk, "豆乳");

			await project(name).remove(list);

			expect(await queued(name)).toBe(0);
		});
	});

	describe("保存の形の移行", () => {
		it("移行の途中で失敗したら、その移行はなかったことになる(やり直せる)", async () => {
			const stub = project("migrate-atomic");
			await runInDurableObject(stub, (_instance, state) => {
				const { sql } = state.storage;
				const good = "CREATE TABLE extra_a (id TEXT)";
				const bad = "CREATE TABLE extra_b (id TEXT); CREATE TABLE extra_b (id TEXT);";
				const applied = () =>
					sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version").one().n;
				const before = applied();
				const tables = () =>
					sql
						.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'extra_%'")
						.toArray()
						.map((row) => row.name);

				expect(() => migrate(state.storage, [...MIGRATIONS, good, bad])).toThrow();

				// 先の移行は済んでいる。失敗した移行は、途中まで作った表ごと、なかったことになる。
				expect(tables()).toEqual(["extra_a"]);
				expect(applied()).toBe(before + 1);
			});
		});

		it("索引の内容を持たない形で保存された台帳を、いまの形にする。ページは残る", async () => {
			const stub = project("migrate-v1");
			await runInDurableObject(stub, (_instance, state) => {
				const { sql } = state.storage;
				// ADR-0024 の時点の形に戻す。
				sql.exec(
					"DROP TABLE renames; DROP TABLE rewrites; DROP TABLE removed; DROP TABLE links; DROP TABLE pages; DROP TABLE schema_version;",
				);
				sql.exec(`CREATE TABLE pages (
					id TEXT PRIMARY KEY, title_lc TEXT NOT NULL UNIQUE, title TEXT NOT NULL, problem TEXT,
					version INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
				)`);
				sql.exec("INSERT INTO pages VALUES ('p1', '前からある', '前からある', NULL, 3, 100, 200)");

				migrate(state.storage);
				migrate(state.storage);
			});

			expect(await stub.list({ sort: "updated" })).toEqual({
				pages: [
					{
						id: "p1",
						title: "前からある",
						descriptions: [],
						image: null,
						updated: 200,
						created: 100,
						linked: 0,
						pinned: false,
					},
				],
				total: 1,
			});
		});
	});
});
