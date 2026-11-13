import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { PageSummary } from "@amime/parser";
import type { PageId } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { MAX_LIST_LIMIT, MIGRATIONS, migrate, PLACEHOLDER_MAX_AGE_MS } from "./project-do.ts";

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
			await runInDurableObject(stub, (instance, state) => {
				// リンクを書き込むところで失敗させる(名前は、その前に書き込まれる)。
				state.storage.sql.exec("ALTER TABLE links RENAME TO links_away");

				expect(() =>
					instance.index(page.id, saved("新しい名前", 2, { links: ["牛乳"] })),
				).toThrow();

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
					"DROP TABLE removed; DROP TABLE links; DROP TABLE pages; DROP TABLE schema_version;",
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
