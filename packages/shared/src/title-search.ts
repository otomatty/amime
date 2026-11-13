/** 文字が飛び飛びに合うときの、あいだの文字数として数える上限。 */
const MAX_GAP = 99;

/** 照らし合わせるための形にする。大文字小文字と、空白かアンダースコアかの違いをなくす。 */
const normalize = (text: string): string => text.replaceAll("_", " ").toLowerCase();

/** 入力を、検索の語に分ける。空白(とアンダースコア)で区切り、小文字にそろえる。 */
export function searchTerms(query: string): string[] {
	return normalize(query)
		.split(/\s+/)
		.filter((term) => term !== "");
}

/** from から後ろへ、wanted の文字を順に探す。すべて見つかったら、最後の文字の位置。見つからなければ -1。 */
function matchForward(
	wanted: readonly string[],
	characters: readonly string[],
	from: number,
): number {
	let matched = 0;
	for (let position = from; position < characters.length; position += 1) {
		if (characters[position] !== wanted[matched]) continue;
		matched += 1;
		if (matched === wanted.length) return position;
	}
	return -1;
}

/** end から前へ、wanted の文字を後ろから順に探す。すべて見つかった位置(最初の文字の位置)を返す。 */
function matchBackward(
	wanted: readonly string[],
	characters: readonly string[],
	end: number,
): number {
	let left = wanted.length;
	let position = end;
	// end までに、wanted の文字が順に出てくることは、分かっている。
	for (; left > 0; position -= 1) {
		if (characters[position] === wanted[left - 1]) left -= 1;
	}
	return position + 1;
}

/**
 * term の文字が、haystack の中に順に出てくるなら、最初の文字から最後の文字までの長さ。出てこなければ null。
 * 合うところがいくつもあれば、いちばん短いものの長さ。
 */
function scatteredSpan(term: string, haystack: string): number | null {
	const wanted = Array.from(term);
	const characters = Array.from(haystack);
	let shortest: number | null = null;
	// 前から合わせて終わりを決め、そこから後ろへ合わせ直して、始まりをできるだけ後ろに寄せる。
	for (let from = 0; ; ) {
		const end = matchForward(wanted, characters, from);
		if (end === -1) return shortest;
		const start = matchBackward(wanted, characters, end);
		shortest = Math.min(shortest ?? Number.POSITIVE_INFINITY, end - start + 1);
		from = start + 1;
	}
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
 * SQL の LIKE の型の、長さの上限(バイト)。Cloudflare の SQLite(D1、Durable Objects)の制限。
 * 超えると、問い合わせが失敗する。
 */
export const MAX_LIKE_PATTERN_BYTES = 50;

/** 文字(コードポイント1つ)の、UTF-8 でのバイト数。 */
function utf8Bytes(character: string): number {
	const code = Number(character.codePointAt(0));
	return [0x80, 0x800, 0x10000].filter((limit) => code >= limit).length + 1;
}

/**
 * 語の文字が順に出てくる文字列を探す、SQL の LIKE の型。エスケープの文字は `\`。
 * 候補を絞るために使う(合う順は、scoreTitle で決める)。
 * 型の長さには上限があるので、長い語は、いくつかの型に分ける。すべての型に合うものを、候補にする
 * (分けた型どうしの順は確かめないので、合わないものも候補に混ざる。scoreTitle が取り除く)。
 */
export function likePatterns(term: string): string[] {
	const patterns: string[] = [];
	// 型は「%」で始まり、文字ごとに「文字%」が続く。
	let pattern = "%";
	let bytes = 1;
	for (const character of term) {
		const escaped = `${character.replace(/[\\%_]/, "\\$&")}%`;
		// エスケープの文字と「%」は、1バイトずつ。
		const added = utf8Bytes(character) + escaped.length - character.length;
		if (bytes + added > MAX_LIKE_PATTERN_BYTES) {
			patterns.push(pattern);
			pattern = "%";
			bytes = 1;
		}
		pattern += escaped;
		bytes += added;
	}
	return pattern === "%" ? patterns : [...patterns, pattern];
}
