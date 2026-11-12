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

/** 送信中の変更が、すべてサーバーに入ったとしたときの文書。 */
const sent = (session: Session): readonly Line[] =>
	session.inflight === null
		? session.confirmed
		: applyChanges(session.confirmed, session.inflight).lines;

/**
 * 確定した文書を新しいものに進め、画面の文書を作り直す。
 * base から画面の文書までの差分が「まだサーバーに入っていない自分の編集」で、それを新しい確定した文書に載せ直す。
 * サーバーが同じ変更を受け取ったときと同じ規則で適用するので、画面の文書はサーバーの結果と食い違わない。
 */
function rebase(
	session: Session,
	version: number,
	confirmed: readonly Line[],
	base: readonly Line[],
): Session {
	const local = applyChanges(confirmed, diffLines(base, session.local)).lines;
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
	const confirmed = applyChanges(session.confirmed, result.applied).lines;
	return rebase(session, result.version, confirmed, sent(session));
}

/**
 * 他の人のコミットを受け取る。確定した文書を進め、画面の文書に反映する。
 * 送信中の変更と、まだ送っていない編集は、その上に載せ直す。送信中の状態は変えない。
 *
 * 既に反映してあるバージョンなら、何もしない。あいだのバージョンが抜けていたら null を返す。
 * そのときは、ページを読み直して recover(送信中なら、応答を待ってから)を呼ぶ。
 */
export function receive(session: Session, event: CommitResult): Session | null {
	if (event.version <= session.version) return session;
	if (event.version !== session.version + 1) return null;

	const confirmed = applyChanges(session.confirmed, event.applied).lines;
	const unsent = diffLines(sent(session), session.local);
	const next = { ...session, version: event.version, confirmed };
	const local = applyChanges(sent(next), unsent).lines;
	return { ...next, local: sameLines(local, session.local) ? session.local : local };
}

/**
 * 読み直したページを確定した文書にする。まだ送っていない編集は、その上に載せ直す。
 * 送信中の変更は、サーバーに入っている(読み直したページに含まれている)ものとして扱う。
 */
export function resync(session: Session, snapshot: PageSnapshot): Session {
	return rebase(session, snapshot.version, snapshot.lines, sent(session));
}

/**
 * 応答が届かなかった送信のあとで、読み直したページを確定した文書にする。
 * 送信中の変更がサーバーに入ったかどうかは分からない。入っていても、いなくても正しくなるように、
 * 前の確定した文書からの自分の変更をすべて載せ直す(入っていた変更は、もう一度適用しても何も起こさない)。
 *
 * 送ったあとで取り消して元に戻していた場合は、取り消すつもりだったかどうかを判断できないので、
 * 画面はサーバーの内容になる。
 */
export function recover(session: Session, snapshot: PageSnapshot): Session {
	return rebase(session, snapshot.version, snapshot.lines, session.confirmed);
}

/**
 * サーバーに断られた送信をやめる。サーバーには入っていないことが分かっているときにだけ使う。
 * 変更は画面の文書に残っているので、次の送信でもう一度送られる。
 */
export function failed(session: Session): Session {
	return { ...session, inflight: null };
}

/**
 * まだサーバーに入っていない(かもしれない)自分の変更を、確定した文書からの変更として取り出す。
 * 送信中の変更も含める。端末内に残しておき、次に開いたときに withPending で載せ直すために使う。
 */
export function pendingChanges(session: Session): readonly Change[] {
	return diffLines(session.confirmed, session.local);
}

/**
 * 残しておいた未送信の変更を、読み込んだページに載せ直す。records は、載せる順に渡す。
 * 既にサーバーに入っていた変更は、もう一度適用しても何も起こさない(ADR-0016)。
 */
export function withPending(
	lines: readonly Line[],
	records: readonly (readonly Change[])[],
): readonly Line[] {
	return records.reduce((current, changes) => applyChanges(current, changes).lines, lines);
}
