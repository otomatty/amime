import { DurableObject } from "cloudflare:workers";
import type { PageSummary } from "@amime/parser";
import { MAX_TITLE_LENGTH, titleFromName, titleOfLine, toTitleLc } from "@amime/shared";
import type { PageCard, PageId, PageInfo, PageList, PageSort, TitleProblem } from "@amime/sync";

/** 開いただけで保存されていないページを、台帳に残しておく期間。 */
export const PLACEHOLDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 1行目が空のページを台帳に載せるときの、仮の名前。 */
const UNTITLED = "無題";

type PageRow = {
	id: string;
	title: string;
	title_lc: string;
	problem: string | null;
	version: number;
	pinned: number;
};

const PAGE_COLUMNS = "id, title, title_lc, problem, version, pinned";

/** PageDO が知らせてくる、ページのいまの状態。 */
type PageState = {
	/** ページの1行目。 */
	readonly title: string;
	/** ページのバージョン。1以上なら、保存されたページ。 */
	readonly version: number;
	/** 最後に変更された時刻(ミリ秒)。 */
	readonly updated: number;
	/** 一覧やリンクのつながりのために、ページから取り出した情報。 */
	readonly summary: PageSummary;
};

/** 一覧を取り出すときの指定。 */
type ListOptions = {
	readonly sort: PageSort;
	/** 取り出す件数。省くと、上限まで。 */
	readonly limit?: number;
	/** 何件目から取り出すか。 */
	readonly offset?: number;
};

/** 一覧で、1度に取り出せる件数の上限。 */
export const MAX_LIST_LIMIT = 100;

/** 並び順ごとの、SQL の並べ方。同じ値のページは、名前の順にする(順序が、取り出すたびに変わらないように)。 */
/** 固定したページを先頭に並べる。あとから固定したものを前にする。 */
const PINNED_FIRST = "pinned > 0 DESC, pinned DESC";

const ORDER_BY: Readonly<Record<PageSort, string>> = {
	updated: "updated DESC, title_lc",
	created: "created DESC, title_lc",
	title: "title_lc",
	linked: "linked DESC, title_lc",
};

/**
 * 台帳の保存の形。前から順に適用する。適用した数を schema_version に覚えておく。
 * 形を変えるときは、末尾に足す(適用済みのものは書き換えない)。
 */
export const MIGRATIONS: readonly string[] = [
	// 1: 名前とIDの対応(ADR-0024)。
	`CREATE TABLE IF NOT EXISTS pages (
		id TEXT PRIMARY KEY,
		title_lc TEXT NOT NULL UNIQUE,
		title TEXT NOT NULL,
		problem TEXT,
		version INTEGER NOT NULL DEFAULT 0,
		created INTEGER NOT NULL,
		updated INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS pages_placeholder ON pages (version, created);`,
	// 2: 一覧とリンクのつながりのための索引(ADR-0025)。
	`ALTER TABLE pages ADD COLUMN descriptions TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE pages ADD COLUMN image TEXT;
	CREATE TABLE links (
		from_id TEXT NOT NULL,
		to_lc TEXT NOT NULL,
		PRIMARY KEY (from_id, to_lc)
	);
	CREATE INDEX links_to ON links (to_lc);`,
	// 3: 一覧の先頭への固定と、削除したページの記録(ADR-0026)。pinned は固定した時刻(固定していなければ 0)。
	`ALTER TABLE pages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
	CREATE TABLE removed (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		removed INTEGER NOT NULL
	);`,
];

/**
 * 台帳の保存の形を、いまの形にする。何度呼んでもよい。
 * 移行は、1つずつまとめて確定する。途中で失敗した移行は、なかったことになり、次に開いたときにやり直す。
 */
export function migrate(storage: DurableObjectStorage, migrations = MIGRATIONS): void {
	const { sql } = storage;
	sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
	const applied = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version").one().n;
	migrations.slice(applied).forEach((migration, index) => {
		storage.transactionSync(() => {
			sql.exec(migration);
			sql.exec("INSERT INTO schema_version (version) VALUES (?)", applied + index + 1);
		});
	});
}

const PROBLEMS: ReadonlySet<string | null> = new Set(["taken", "empty", "too-long", "reserved"]);

/** URLのパスの中で、別の場所を指す書き方になる名前。ページの名前にできない。 */
const DOT_SEGMENTS: ReadonlySet<string> = new Set([".", ".."]);

/** 1行目(wanted)そのものが、名前にできない理由。できるなら null。他のページとの重なりは見ない。 */
function unusable(wanted: string): TitleProblem | null {
	if (wanted === "") return "empty";
	if (wanted.length > MAX_TITLE_LENGTH) return "too-long";
	return DOT_SEGMENTS.has(wanted) ? "reserved" : null;
}

/** 文字列の SHA-256 を、16進で返す。 */
async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** ページIDの長さ(16進の文字数)。 */
const PAGE_ID_LENGTH = 32;

/**
 * 1プロジェクト = 1インスタンス。プロジェクトのページの台帳を持つ(ADR-0003、ADR-0024)。
 *
 * ページは、変わらないID(PageId)で識別する。台帳は、名前(タイトル)からIDを引けるようにする。
 * 名前は、プロジェクトの中で重ならない(大文字小文字と、空白かアンダースコアかの違いは、同じ名前)。
 * ページの本文は PageDO が持つ。ここは、名前とIDの対応と、一覧や検索のための索引だけを持つ。
 */
export class ProjectDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		migrate(ctx.storage);
	}

	/**
	 * 名前からページを引く。まだなければ、IDを決めて台帳に載せる。
	 * 載せただけのページは「開いただけ」の状態で、一覧には出ない。保存されないまま1日たつと、台帳から消える。
	 */
	async open(name: string): Promise<PageInfo> {
		this.#sweep();
		const existing = this.#byTitle(toTitleLc(name));
		if (existing !== null) return toInfo(existing);
		const id = await this.#newId(toTitleLc(name));
		// IDを決めているあいだに、同じ名前が載っていたら、そちらを返す。
		const raced = this.#byTitle(toTitleLc(name));
		return raced === null ? this.#insert(id, titleFromName(name), null, 0) : toInfo(raced);
	}

	/**
	 * まだないページのIDを決める。IDは、名前から決まる(プロジェクト、名前、0 から数えた番号のハッシュ)。
	 *
	 * 「開いただけ」のページが台帳から消えたあとで、同じ名前をもう一度開いても、同じIDになる。
	 * 端末内に残した未送信の変更は、IDごとに残っている(ADR-0020)。IDが変わると、復元できなくなる。
	 * その名前から決まるIDを、名前を変えたあとの前のページが使っていたら、次の番号のIDにする。
	 */
	async #newId(titleLc: string): Promise<PageId> {
		for (let number = 0; ; number += 1) {
			// プロジェクト(この Durable Object の名前)も含める。別のプロジェクトの同じ名前のページと、IDが重ならない。
			const source = `${this.ctx.id.name}\n${titleLc}\n${number}`;
			const id = (await sha256(source)).slice(0, PAGE_ID_LENGTH) as PageId;
			// 削除したページのIDは、使い回さない。
			if (this.#byId(id) === null && this.#removedTitle(id) === null) return id;
		}
	}

	/**
	 * 保存されたページの一覧を返す(ADR-0025)。開いただけのページは含めない。
	 * linked は、他のページからリンクされている数。
	 */
	list({ sort, limit = MAX_LIST_LIMIT, offset = 0 }: ListOptions): PageList {
		const { sql } = this.ctx.storage;
		const rows = sql
			.exec<CardRow>(
				`SELECT id, title, descriptions, image, updated, created, pinned,
					(SELECT COUNT(*) FROM links WHERE to_lc = pages.title_lc AND from_id != pages.id) AS linked
				FROM pages WHERE version > 0 ORDER BY ${PINNED_FIRST}, ${ORDER_BY[sort]} LIMIT ? OFFSET ?`,
				Math.min(Math.max(limit, 0), MAX_LIST_LIMIT),
				Math.max(offset, 0),
			)
			.toArray();
		const total = sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE version > 0")
			.one().n;
		return { pages: rows.map(toCard), total };
	}

	/**
	 * ページのいまの状態を、台帳に反映する。PageDO が、ページが変更されたあとで呼ぶ。
	 *
	 * ページの名前を、1行目に合わせる(ADR-0024)。合わせられないとき(同じ名前のページがある、
	 * 1行目が空、長すぎる)は、名前を変えずに、理由を返す。
	 * 一覧とリンクのつながりのための情報(冒頭の本文、画像、リンク先)も、ここで入れ替える(ADR-0025)。
	 */
	index(id: PageId, state: PageState): PageInfo {
		// 削除したページについての知らせが、あとから届いた。台帳に載せ直さない。
		const removed = this.#removedTitle(id);
		if (removed !== null) return { id, title: removed, problem: null, pinned: false };
		// 名前・要約・リンク先を、まとめて確定する。途中で失敗して、一部だけが新しくなることがないようにする。
		return this.ctx.storage.transactionSync(() => {
			const info = this.#retitle(id, state);
			this.#summarize(id, state.summary);
			return info;
		});
	}

	/**
	 * ページを、一覧の先頭に固定する(pinned が false なら、固定を外す)。ADR-0026。
	 * 台帳にないページなら null。
	 */
	pin(id: PageId, pinned: boolean): PageInfo | null {
		this.ctx.storage.sql.exec(
			"UPDATE pages SET pinned = ? WHERE id = ?",
			pinned ? Date.now() : 0,
			id,
		);
		const row = this.#byId(id);
		return row === null ? null : toInfo(row);
	}

	/**
	 * ページを台帳から消す(ADR-0026)。本文は、PageDO が消す。
	 * 消したページのIDは覚えておき、使い回さない(同じ名前で作り直したページが、消したページの続きにならないように)。
	 */
	remove(id: PageId): void {
		const { sql } = this.ctx.storage;
		const title = this.#byId(id)?.title ?? "";
		// 消したことの記録と、台帳から消すことを、まとめて確定する。
		this.ctx.storage.transactionSync(() => {
			sql.exec(
				"INSERT INTO removed (id, title, removed) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
				id,
				title,
				Date.now(),
			);
			sql.exec("DELETE FROM links WHERE from_id = ?", id);
			sql.exec("DELETE FROM pages WHERE id = ?", id);
		});
	}

	/** 削除したページなら、そのときの名前。削除していなければ null。 */
	#removedTitle(id: PageId): string | null {
		const rows = this.ctx.storage.sql
			.exec<{ title: string }>("SELECT title FROM removed WHERE id = ?", id)
			.toArray();
		return rows[0]?.title ?? null;
	}

	/** 冒頭の本文・画像・リンク先を入れ替える。リンク先は、変わった分だけを書き込む。 */
	#summarize(id: PageId, { descriptions, image, links }: PageSummary): void {
		const { sql } = this.ctx.storage;
		sql.exec(
			"UPDATE pages SET descriptions = ?, image = ? WHERE id = ?",
			JSON.stringify(descriptions),
			image,
			id,
		);
		const wanted = new Set<string>(links.map((title) => toTitleLc(title)));
		const current = new Set(
			sql
				.exec<{ to_lc: string }>("SELECT to_lc FROM links WHERE from_id = ?", id)
				.toArray()
				.map((row) => row.to_lc),
		);
		for (const target of current) {
			if (!wanted.has(target))
				sql.exec("DELETE FROM links WHERE from_id = ? AND to_lc = ?", id, target);
		}
		for (const target of wanted) {
			if (!current.has(target))
				sql.exec("INSERT INTO links (from_id, to_lc) VALUES (?, ?)", id, target);
		}
	}

	#retitle(id: PageId, state: PageState): PageInfo {
		const wanted = titleOfLine(state.title);
		const row = this.#byId(id);
		// 台帳にないページ(開いただけのあいだに、名前を他のページに取られた)。重ならない名前で載せる。
		if (row === null) return this.#adopt(id, wanted, state);

		const problem = this.#problemOf(wanted, row);
		const title = problem === null ? wanted : row.title;
		if (problem === null && toTitleLc(wanted) !== row.title_lc) this.#evictPlaceholder(wanted);
		this.ctx.storage.sql.exec(
			"UPDATE pages SET title = ?, title_lc = ?, problem = ?, version = ?, updated = ? WHERE id = ?",
			title,
			toTitleLc(title),
			problem,
			state.version,
			state.updated,
			id,
		);
		return { id, title, problem, pinned: row.pinned > 0 };
	}

	/** 1行目(wanted)を名前にできない理由。できるなら null。 */
	#problemOf(wanted: string, row: PageRow): TitleProblem | null {
		const problem = unusable(wanted);
		if (problem !== null) return problem;
		const holder = this.#byTitle(toTitleLc(wanted));
		// 開いただけで保存されていないページの名前は、空いているものとして扱う。
		return holder === null || holder.id === row.id || holder.version === 0 ? null : "taken";
	}

	/** その名前を持っている「開いただけ」のページを、台帳から消す。 */
	#evictPlaceholder(title: string): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM pages WHERE title_lc = ? AND version = 0",
			toTitleLc(title),
		);
	}

	/** 台帳にないページを、重ならない名前で載せる。 */
	#adopt(id: PageId, wanted: string, state: PageState): PageInfo {
		const problem = unusable(wanted);
		const base = problem === null ? wanted : UNTITLED;
		const holder = this.#byTitle(toTitleLc(base));
		if (holder !== null && holder.version === 0) this.#evictPlaceholder(base);
		const free = holder === null || holder.version === 0;
		const title = free ? base : this.#numbered(base);
		return this.#insert(
			id,
			title,
			problem ?? (free ? null : "taken"),
			state.version,
			state.updated,
		);
	}

	/** 「名前 (2)」「名前 (3)」…のうち、空いている最初のもの。番号を付けても、名前の長さの上限に収める。 */
	#numbered(base: string): string {
		for (let number = 2; ; number += 1) {
			const suffix = ` (${number})`;
			// 文字(サロゲートの組)の途中で切れたら、残った片方を取り除く。
			const head = base.slice(0, MAX_TITLE_LENGTH - suffix.length);
			const candidate = `${head.isWellFormed() ? head : head.slice(0, -1)}${suffix}`;
			if (this.#byTitle(toTitleLc(candidate)) === null) return candidate;
		}
	}

	#insert(
		id: PageId,
		title: string,
		problem: TitleProblem | null,
		version: number,
		updated = Date.now(),
	): PageInfo {
		this.ctx.storage.sql.exec(
			"INSERT INTO pages (id, title_lc, title, problem, version, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id,
			toTitleLc(title),
			title,
			problem,
			version,
			Date.now(),
			updated,
		);
		return { id, title, problem, pinned: false };
	}

	/** 開いただけで保存されないまま、期間を過ぎたページを消す。 */
	#sweep(): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM pages WHERE version = 0 AND created < ?",
			Date.now() - PLACEHOLDER_MAX_AGE_MS,
		);
	}

	#byTitle(titleLc: string): PageRow | null {
		return this.#one(`SELECT ${PAGE_COLUMNS} FROM pages WHERE title_lc = ?`, titleLc);
	}

	#byId(id: PageId): PageRow | null {
		return this.#one(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, id);
	}

	#one(query: string, value: string): PageRow | null {
		return this.ctx.storage.sql.exec<PageRow>(query, value).toArray()[0] ?? null;
	}
}

type CardRow = {
	id: string;
	title: string;
	descriptions: string;
	image: string | null;
	updated: number;
	created: number;
	linked: number;
	pinned: number;
};

/** 台帳の行を、一覧に出す情報にする。 */
function toCard(row: CardRow): PageCard {
	// 保存してあるIDと冒頭の本文は、書き込むときに決めたもの(冒頭の本文は、文字列の配列のJSON)。
	const descriptions = JSON.parse(row.descriptions) as string[];
	return { ...row, id: row.id as PageId, descriptions, pinned: row.pinned > 0 };
}

/** 台帳の行を、ページの情報にする。 */
function toInfo(row: PageRow): PageInfo {
	// 保存してあるIDと理由は、書き込むときに決めたもの。
	const problem = PROBLEMS.has(row.problem) ? (row.problem as TitleProblem | null) : null;
	return { id: row.id as PageId, title: row.title, problem, pinned: row.pinned > 0 };
}
