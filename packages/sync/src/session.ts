import { applyChanges, diffLines } from "./changes.ts";
import { MAX_CHANGES, MAX_COMMIT_TEXT_LENGTH } from "./schema.ts";
import type { Change, CommitResult, Line, PageSnapshot } from "./types.ts";

/**
 * 1つの端末から見た、ページの状態(ADR-0016)。
 * 「サーバーが確定した文書」と「画面の文書」を分けて持つ。その差が、まだ保存されていない変更である。
 */
export type Session = {
	/** 確定した文書のバージョン。 */
	readonly version: number;
	/** サーバーが確定した文書。 */
	readonly confirmed: readonly Line[];
	/** 送信して、応答を待っている変更。送信中でなければ null。 */
	readonly inflight: readonly Change[] | null;
	/** 画面の文書。確定した文書に、自分の未確定の変更を適用したもの。 */
	readonly local: readonly Line[];
};

/** 2つの文書の内容(行IDと本文の並び)が同じか。 */
export const sameLines = (a: readonly Line[], b: readonly Line[]): boolean =>
	a.length === b.length &&
	a.every((line, index) => line.id === b[index]?.id && line.text === b[index]?.text);

/** 読み込んだページから始める。 */
export function createSession(snapshot: PageSnapshot): Session {
	return {
		version: snapshot.version,
		confirmed: snapshot.lines,
		inflight: null,
		local: snapshot.lines,
	};
}

/** 画面の文書を、編集後のものに置き換える。 */
export function edit(session: Session, local: readonly Line[]): Session {
	return local === session.local ? session : { ...session, local };
}

/** まだ保存されていない変更(送信中のものを含む)があるか。 */
export function hasUnsaved(session: Session): boolean {
	return session.inflight !== null || !sameLines(session.confirmed, session.local);
}

function textLength(change: Change): number {
	if (change.type === "insert") return change.line.text.length;
	return change.type === "update" ? change.text.length : 0;
}

/**
 * 差分の先頭から、1つのコミットに収まる分を取り出す。少なくとも1つは取り出す。
 * 差分は上から順に適用できる並びなので、途中までを先に送っても正しく適用できる。
 */
function firstCommit(changes: readonly Change[]): readonly Change[] {
	let length = 0;
	const end = changes.findIndex((change, index) => {
		length += textLength(change);
		return index > 0 && (index >= MAX_CHANGES || length > MAX_COMMIT_TEXT_LENGTH);
	});
	return end === -1 ? changes : changes.slice(0, end);
}

/**
 * 送信を始める。送る変更は、確定した文書と画面の文書の差分。
 * 差分が1つのコミットに収まらなければ、収まる分だけを送る(残りは、次の送信で送られる)。
 * 送信中か、送る変更がなければ null。1度に送るコミットは1つだけ。
 */
export function send(session: Session): { session: Session; changes: readonly Change[] } | null {
	if (session.inflight !== null) return null;
	const changes = firstCommit(diffLines(session.confirmed, session.local));
	if (changes.length === 0) return null;
	return { session: { ...session, inflight: changes }, changes };
}

/**
 * 確定した文書を新しいものに進め、まだ送っていない編集(送信後に書き足した分)を載せ直す。
 * サーバーが同じ変更を受け取ったときと同じ規則で適用するので、画面の文書はサーバーの結果と食い違わない。
 */
function rebase(session: Session, version: number, confirmed: readonly Line[]): Session {
	const sent =
		session.inflight === null
			? session.confirmed
			: applyChanges(session.confirmed, session.inflight).lines;
	const local = applyChanges(confirmed, diffLines(sent, session.local)).lines;
	// 内容が変わらなければ同じ配列を保つ(編集欄を置き換えずに済む)。
	return {
		version,
		confirmed,
		inflight: null,
		local: sameLines(local, session.local) ? session.local : local,
	};
}

/**
 * 送信したコミットへの応答を反映する。
 * バージョンが飛んでいたら(他の人の変更が先に入っていたら)null を返す。
 * そのときは、ページを読み直して resync を呼ぶ。
 */
export function acknowledge(session: Session, result: CommitResult): Session | null {
	const expected = session.version + (result.applied.length > 0 ? 1 : 0);
	if (result.version !== expected) return null;
	return rebase(session, result.version, applyChanges(session.confirmed, result.applied).lines);
}

/** 読み直したページを確定した文書にする。まだ送っていない編集は、その上に載せ直す。 */
export function resync(session: Session, snapshot: PageSnapshot): Session {
	return rebase(session, snapshot.version, snapshot.lines);
}

/**
 * 送信に失敗したときに、送信中の状態をやめる。変更は画面の文書に残っているので、次の送信でもう一度送られる。
 * 応答だけが届かずサーバーには入っていた場合も、同じ変更は二重に効かない(ADR-0016)。
 */
export function failed(session: Session): Session {
	return { ...session, inflight: null };
}
