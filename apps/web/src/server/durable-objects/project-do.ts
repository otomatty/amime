import { DurableObject } from "cloudflare:workers";
import { MAX_TITLE_LENGTH, titleFromName, titleOfLine, toTitleLc } from "@amime/shared";
import type { PageId, PageInfo, TitleProblem } from "@amime/sync";

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
};

/** PageDO が知らせてくる、ページのいまの状態。 */
type PageState = {
	/** ページの1行目。 */
	readonly title: string;
	/** ページのバージョン。1以上なら、保存されたページ。 */
	readonly version: number;
	/** 最後に変更された時刻(ミリ秒)。 */
	readonly updated: number;
};

const PROBLEMS: ReadonlySet<string | null> = new Set(["taken", "empty", "too-long"]);

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
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS pages (
				id TEXT PRIMARY KEY,
				title_lc TEXT NOT NULL UNIQUE,
				title TEXT NOT NULL,
				problem TEXT,
				version INTEGER NOT NULL DEFAULT 0,
				created INTEGER NOT NULL,
				updated INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pages_placeholder ON pages (version, created);
		`);
	}

	/**
	 * 名前からページを引く。まだなければ、IDを決めて台帳に載せる。
	 * 載せただけのページは「開いただけ」の状態で、一覧には出ない。保存されないまま1日たつと、台帳から消える。
	 */
	open(name: string): PageInfo {
		this.#sweep();
		const existing = this.#byTitle(toTitleLc(name));
		if (existing !== null) return toInfo(existing);
		return this.#insert(crypto.randomUUID() as PageId, titleFromName(name), null, 0);
	}

	/**
	 * ページの名前を、1行目に合わせる。PageDO が、ページが変更されたあとで呼ぶ。
	 * 合わせられないとき(同じ名前のページがある、1行目が空、長すぎる)は、名前を変えずに、理由を返す。
	 */
	retitle(id: PageId, state: PageState): PageInfo {
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
		return { id, title, problem };
	}

	/** 1行目(wanted)を名前にできない理由。できるなら null。 */
	#problemOf(wanted: string, row: PageRow): TitleProblem | null {
		if (wanted === "") return "empty";
		if (wanted.length > MAX_TITLE_LENGTH) return "too-long";
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
		const usable = wanted !== "" && wanted.length <= MAX_TITLE_LENGTH;
		const base = usable ? wanted : UNTITLED;
		const holder = this.#byTitle(toTitleLc(base));
		if (holder !== null && holder.version === 0) this.#evictPlaceholder(base);
		const free = holder === null || holder.version === 0;
		const problem = usable ? (free ? null : "taken") : wanted === "" ? "empty" : "too-long";
		const title = free ? base : this.#numbered(base);
		return this.#insert(id, title, problem, state.version, state.updated);
	}

	/** 「名前 (2)」「名前 (3)」…のうち、空いている最初のもの。 */
	#numbered(base: string): string {
		for (let number = 2; ; number += 1) {
			const candidate = `${base} (${number})`;
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
		return { id, title, problem };
	}

	/** 開いただけで保存されないまま、期間を過ぎたページを消す。 */
	#sweep(): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM pages WHERE version = 0 AND created < ?",
			Date.now() - PLACEHOLDER_MAX_AGE_MS,
		);
	}

	#byTitle(titleLc: string): PageRow | null {
		return this.#one(
			"SELECT id, title, title_lc, problem, version FROM pages WHERE title_lc = ?",
			titleLc,
		);
	}

	#byId(id: PageId): PageRow | null {
		return this.#one("SELECT id, title, title_lc, problem, version FROM pages WHERE id = ?", id);
	}

	#one(query: string, value: string): PageRow | null {
		return this.ctx.storage.sql.exec<PageRow>(query, value).toArray()[0] ?? null;
	}
}

/** 台帳の行を、ページの情報にする。 */
function toInfo(row: PageRow): PageInfo {
	// 保存してあるIDと理由は、書き込むときに決めたもの。
	const problem = PROBLEMS.has(row.problem) ? (row.problem as TitleProblem | null) : null;
	return { id: row.id as PageId, title: row.title, problem };
}
