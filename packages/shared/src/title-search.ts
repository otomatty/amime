/** 検索の語の数の上限。 */
export const MAX_SEARCH_TERMS = 5;
/** 検索の語1つの長さの上限(文字数)。 */
const MAX_TERM_LENGTH = 50;
/** 文字が飛び飛びに合うときの、あいだの文字数として数える上限。 */
const MAX_GAP = 99;

/** 照らし合わせるための形にする。大文字小文字と、空白かアンダースコアかの違いをなくす。 */
const normalize = (text: string): string => text.replaceAll("_", " ").toLowerCase();

/**
 * 入力を、検索の語に分ける。空白(とアンダースコア)で区切り、小文字にそろえる。
 * 語の数と長さは、上限までにする。
 */
export function searchTerms(query: string): string[] {
	return normalize(query)
		.split(/\s+/)
		.filter((term) => term !== "")
		.slice(0, MAX_SEARCH_TERMS)
		.map((term) => Array.from(term).slice(0, MAX_TERM_LENGTH).join(""));
}

/** term の文字が、haystack の中に順に出てくるなら、最初の文字から最後の文字までの長さ。出てこなければ null。 */
function scatteredSpan(term: string, haystack: string): number | null {
	const wanted = Array.from(term);
	let matched = 0;
	let first = 0;
	for (const [position, character] of Array.from(haystack).entries()) {
		if (character !== wanted[matched]) continue;
		if (matched === 0) first = position;
		matched += 1;
		if (matched === wanted.length) return position - first + 1;
	}
	return null;
}

/** 1つの語が、名前(正規化したもの)にどれだけ合うか。小さいほど合う。合わなければ null。 */
function scoreTerm(term: string, haystack: string): number | null {
	if (haystack.startsWith(term)) return haystack.length === term.length ? 0 : 1;
	// 名前の中の語(空白のあと)の先頭に合う。
	if (haystack.includes(` ${term}`)) return 2;
	if (haystack.includes(term)) return 3;
	const span = scatteredSpan(term, haystack);
	if (span === null) return null;
	// あいだに挟まる文字が少ないほど合う。
	return 4 + Math.min(span - Array.from(term).length, MAX_GAP) / (MAX_GAP + 1);
}

/**
 * 名前が、検索の語にどれだけ合うか。小さいほど合う。合わない語が1つでもあれば null。
 * 名前の先頭に合うもの、語の先頭に合うもの、途中に合うもの、文字が飛び飛びに合うもの、の順に合う。
 */
export function scoreTitle(terms: readonly string[], title: string): number | null {
	const haystack = normalize(title);
	let total = 0;
	for (const term of terms) {
		const score = scoreTerm(term, haystack);
		if (score === null) return null;
		total += score;
	}
	return total;
}

/**
 * 名前のうち、入力に合うものを、合う順に並べる。limit 件まで。
 * 同じくらい合うものは、短い名前を先にする。それも同じなら、渡された順のまま。
 * 入力が空なら、渡された順のまま返す。
 */
export function rankTitles(query: string, titles: readonly string[], limit: number): string[] {
	const terms = searchTerms(query);
	if (terms.length === 0) return titles.slice(0, limit);
	return titles
		.flatMap((title) => {
			const score = scoreTitle(terms, title);
			return score === null ? [] : [{ title, score }];
		})
		.sort((a, b) => a.score - b.score || a.title.length - b.title.length)
		.slice(0, limit)
		.map(({ title }) => title);
}

/**
 * 語の文字が順に出てくる文字列を探す、SQL の LIKE の型。エスケープの文字は `\`。
 * 候補を絞るために使う(合う順は、scoreTitle で決める)。
 */
export function likePattern(term: string): string {
	const characters = Array.from(term, (character) => character.replace(/[\\%_]/, "\\$&"));
	return `%${characters.join("%")}%`;
}
