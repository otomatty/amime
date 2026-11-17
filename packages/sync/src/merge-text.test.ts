import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mapColumn, mergeText } from "./merge-text.ts";

/** 2つの文字列に共通する、順に並んだ文字の、最も多い数(テストで比べるための素直な計算)。 */
function longestCommon(a: string, b: string): number {
	let next = new Array<number>(b.length + 1).fill(0);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		const row = new Array<number>(b.length + 1).fill(0);
		for (let j = b.length - 1; j >= 0; j -= 1) {
			row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
		next = row;
	}
	return next[0] ?? 0;
}

describe("mergeText", () => {
	it("片方しか変えていなければ、変えたほうになる", () => {
		expect(mergeText("abc", "abc", "abXc")).toBe("abXc");
		expect(mergeText("abc", "aXbc", "abc")).toBe("aXbc");
	});

	it("両方が同じ本文にしていれば、その本文になる", () => {
		expect(mergeText("abc", "abXc", "abXc")).toBe("abXc");
	});

	it("別々の場所に足した文字は、どちらも残る", () => {
		expect(mergeText("今日は晴れ", "今日は晴れです", "たぶん今日は晴れ")).toBe(
			"たぶん今日は晴れです",
		);
	});

	it("別々の場所で消した文字は、どちらも消える", () => {
		expect(mergeText("abcdef", "acdef", "abcdf")).toBe("acdf");
	});

	it("片方が足し、片方が別の場所を消していれば、両方とも効く", () => {
		expect(mergeText("abcdef", "abXcdef", "abcde")).toBe("abXcde");
	});

	it("同じ場所に足した文字は、先に入っていたほうを前にして、どちらも残す", () => {
		expect(mergeText("ab", "aXb", "aYb")).toBe("aXYb");
		expect(mergeText("", "先", "後")).toBe("先後");
	});

	it("片方が置き換えた語の直後に、もう片方が足した文字は、置き換えた語のあとに来る", () => {
		expect(mergeText("dog", "dogs", "cat")).toBe("cats");
		expect(mergeText("dog", "cat", "dogs")).toBe("cats");
		expect(mergeText("dog", "Xdog", "cat")).toBe("Xcat");
		expect(mergeText("dog", "cat", "Xdog")).toBe("Xcat");
	});

	it("両方が同じ語を別の語に置き換えたら、先に入っていたほうを前にして、どちらも残す", () => {
		expect(mergeText("猫", "犬", "鳥")).toBe("犬鳥");
	});

	it("同じ場所に同じ文字を足していれば、1度だけ足す", () => {
		expect(mergeText("ab", "aXb", "aXb")).toBe("aXb");
		expect(mergeText("abc", "aXbc", "aXbYc")).toBe("aXbYc");
	});

	it("同じ場所に足した文字が、途中まで同じでも、それぞれが足したものとして残す", () => {
		// 2人が別々に打った文字は、どちらも入力である。同じ文字で始まっていても、片方を捨てない。
		expect(mergeText("ab", "aXb", "aXYb")).toBe("aXXYb");
	});

	it("両方が同じ文字を消していれば、1度だけ消える", () => {
		expect(mergeText("abc", "ac", "ac")).toBe("ac");
		expect(mergeText("abcd", "acd", "ac")).toBe("ac");
	});

	it("片方が消した範囲の中に、もう片方が足した文字は残る", () => {
		expect(mergeText("abcd", "ad", "abXcd")).toBe("aXd");
	});

	it("片方が消した文字を、もう片方が書き換えていたら、足した文字だけが残る", () => {
		expect(mergeText("猫が好き", "が好き", "犬が好き")).toBe("犬が好き");
	});

	it("絵文字や結合文字を、途中で切らない", () => {
		const family = "👨‍👩‍👧";
		const ga = "が";
		expect(mergeText(`a${family}b`, `a${family}Xb`, `aY${family}b`)).toBe(`aY${family}Xb`);
		expect(mergeText(`${ga}く`, `${ga}っく`, `${ga}くえん`)).toBe(`${ga}っくえん`);
		// 結合文字を足した変更は、文字を置き換えた変更として扱う(か → が)。
		expect(mergeText("かき", `${ga}き`, "かきく")).toBe(`${ga}きく`);
	});

	it("違いが大きすぎるときは、変わった範囲をまるごと置き換えたものとして統合する", () => {
		const base = Array.from({ length: 1200 }, (_, index) => String.fromCodePoint(0x4e00 + index));
		const current = [...base].reverse();
		const incoming = [...base, "末"];

		// 並べ替えた側は「全部を消して、全部を足した」とみなす。
		expect(mergeText(base.join(""), current.join(""), incoming.join(""))).toBe(
			`${current.join("")}末`,
		);
	});

	it("片方しか変えていなければ、いつも変えたほうになる", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (base, changed) => {
				expect(mergeText(base, base, changed)).toBe(changed);
				expect(mergeText(base, changed, base)).toBe(changed);
				expect(mergeText(base, changed, changed)).toBe(changed);
			}),
		);
	});

	it("別々の場所に足した文字は、いつもどちらも残る", () => {
		const letters = fc.string({ unit: fc.constantFrom("a", "b", "c", "あ", "😀"), maxLength: 12 });
		const digits = fc.string({ unit: fc.constantFrom("1", "2", "3"), minLength: 1, maxLength: 4 });
		const upper = fc.string({ unit: fc.constantFrom("X", "Y", "Z"), minLength: 1, maxLength: 4 });
		fc.assert(
			fc.property(letters, letters, letters, digits, upper, (head, middle, tail, one, two) => {
				fc.pre(middle.length > 0);
				const base = `${head}${middle}${tail}`;
				const current = `${head}${one}${middle}${tail}`;
				const incoming = `${head}${middle}${two}${tail}`;

				expect(mergeText(base, current, incoming)).toBe(`${head}${one}${middle}${two}${tail}`);
			}),
		);
	});

	it("同じ文字が続く本文でも、足した文字を落とさない(先頭と末尾の同じ部分が重なるとき)", () => {
		expect(mergeText("aa", "aaa", "aab")).toBe("aaab");
		expect(mergeText("aa", "aab", "aaa")).toBe("aaba");
		expect(mergeText("abab", "ababab", "ababX")).toBe("abababX");
	});

	it("片方が本文を変え、もう片方が末尾に足しただけなら、変えた本文のあとに、足した文字が来る", () => {
		// 変えた側の手順(どの文字を残し、どこに足すか)が、いつも、元の本文を変えたあとの本文にしているか。
		const text = fc.string({ unit: fc.constantFrom("a", "b", "あ", "😀"), maxLength: 10 });
		fc.assert(
			fc.property(text, text, (base, changed) => {
				fc.pre(changed !== base);

				// 末尾に足した文字は、changed が末尾に足した文字よりあと(先に入っていた changed を前にする)。
				expect(mergeText(base, changed, `${base}末`)).toBe(`${changed}末`);
			}),
		);
	});

	it("片方が何か所かで消して足し、もう片方が残っている元の1文字を消したら、その文字は消えて、ほかはそのまま", () => {
		// 書き換えた側は、残した元の文字を、すべて残したものとして見比べる(残す文字を最も多くする)。
		// そうでないと、「消して、足し直した」ことになり、もう片方が消した文字が戻ってしまう。
		// 元の文字は、すべて違う文字にする(同じ文字が並ぶと、どれを消したかが決まらない)。
		const letters = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h"), {
			minLength: 1,
			maxLength: 8,
		});
		const gap = fc.string({ unit: fc.constantFrom("1", "2"), maxLength: 2 });
		const edit = letters.chain((base) =>
			fc.record({
				base: fc.constant(base),
				gaps: fc.array(gap, { minLength: base.length + 1, maxLength: base.length + 1 }),
				keep: fc.array(fc.boolean(), { minLength: base.length, maxLength: base.length }),
				removed: fc.nat(base.length - 1),
			}),
		);
		fc.assert(
			fc.property(edit, ({ base, gaps, keep, removed }) => {
				fc.pre(keep[removed] === true);
				/** 書き換えた側の本文。skip の文字は、もう片方が消したものとして除く。 */
				const write = (skip: number | null) =>
					gaps
						.map((inserted, index) =>
							index < base.length && keep[index] === true && index !== skip
								? inserted + (base[index] ?? "")
								: inserted,
						)
						.join("");
				const original = base.join("");
				const edited = write(null);
				fc.pre(edited !== original);
				const without = base.filter((_, index) => index !== removed).join("");

				expect(mergeText(original, edited, without)).toBe(write(removed));
				expect(mergeText(original, without, edited)).toBe(write(removed));
			}),
			{ numRuns: 300 },
		);
	});

	it("細かく見比べる途中で、変えたあとの本文を読み終えたら、残りの元の文字を消す(範囲の外を読まない)", () => {
		expect(mergeText("cabb", "bca", "cabbZ")).toBe("bcaZ");
	});

	it("同じ文字が並んでいても、残す元の文字は、いつも最も多くする", () => {
		const text = fc.string({ unit: fc.constantFrom("a", "b", "c"), minLength: 1, maxLength: 9 });
		fc.assert(
			fc.property(text, text, (base, changed) => {
				fc.pre(changed !== base);
				// 相手が全部を消すと、残るのは、changed が足した文字だけになる。消えた分が、残した元の文字の数。
				const merged = mergeText(base, changed, "");

				expect(changed.length - merged.length).toBe(longestCommon(base, changed));
			}),
			{ numRuns: 500 },
		);
	});

	it("統合した結果を、同じ変更でもう一度統合しても、足した文字が別々の場所なら変わらない", () => {
		expect(mergeText("abc", mergeText("abc", "aXbc", "abYc"), "abYc")).toBe("aXbYc");
	});
});

describe("mergeText(譲る統合: 取り消しとやり直しのための規則)", () => {
	const yielding = (base: string, current: string, incoming: string) =>
		mergeText(base, current, incoming, { mode: "yield" });

	it("置き換えようとした文字を、相手がすべて消していたら、置き換えない", () => {
		// 自分が「b」を「B2」に書き換えたあと、他の人が行をまるごと書き換えた。取り消しても「b」は戻さない。
		expect(yielding("B2", "他の人の本文", "b")).toBe("他の人の本文");
		expect(yielding("B", "C", "A")).toBe("C");
	});

	it("置き換えようとした文字が一部でも残っていたら、置き換える", () => {
		expect(yielding("dog", "dogs", "cat")).toBe("cats");
		expect(yielding("今日は雨です", "今日は雨", "今日は晴れです")).toBe("今日は晴れ");
	});

	it("足すだけ、消すだけの変更は、ふつうの統合と同じ", () => {
		expect(yielding("今日は晴れです", "たぶん今日は晴れです", "今日は晴れ")).toBe(
			"たぶん今日は晴れ",
		);
		// 自分が消した文字を戻す。相手が同じ場所に足していても、戻す。
		expect(yielding("ac", "aXc", "abc")).toBe("aXbc");
		// 相手がまわりを消していても、戻す(消したのは自分ではなく、戻すのは自分の文字だけ)。
		expect(yielding("ac", "", "abc")).toBe("b");
	});

	it("片方しか変えていなければ、変えたほうになる", () => {
		expect(yielding("abc", "abc", "xyz")).toBe("xyz");
		expect(yielding("abc", "xyz", "abc")).toBe("xyz");
	});
});

describe("mergeText(手間の上限)", () => {
	it("見比べる本文の量が上限を超えたら、統合せずに、あとから届いた本文にする", () => {
		const budget = { chars: 10, cells: 1000 };

		expect(mergeText("今日は晴れ", "今日は晴れです", "たぶん今日は晴れ", { budget })).toBe(
			"たぶん今日は晴れ",
		);
		expect(budget).toEqual({ chars: 10, cells: 1000 });
	});

	it("統合するたびに、見比べた本文の量を上限から引く", () => {
		const budget = { chars: 1000, cells: 1000 };

		mergeText("abc", "aXbc", "abYc", { budget });

		// 3つの本文の長さ(3 + 4 + 4)。変わった範囲に、細かく見比べる文字はない。
		expect(budget).toEqual({ chars: 1000 - 11, cells: 1000 });
	});

	it("変わった範囲を細かく見比べたら、その範囲の大きさを上限から引く", () => {
		const budget = { chars: 1000, cells: 1000 };

		// 「cd」と「XYZ」を見比べる(2 × 3)。
		expect(mergeText("abcde", "abXYZe", "abcdeQ", { budget })).toBe("abXYZeQ");
		expect(budget.cells).toBe(1000 - 6);
	});

	it("細かく見比べる手間が残っていなければ、範囲をまるごと置き換えたものとして統合する(どちらの入力も残る)", () => {
		const budget = { chars: 1000, cells: 5 };

		expect(mergeText("abcde", "abXcYe", "abcdeQ", { budget })).toBe("abXcYeQ");
		expect(budget.cells).toBe(5);
	});

	it("片方しか変えていなければ、手間を使わない", () => {
		const budget = { chars: 0, cells: 0 };

		expect(mergeText("abc", "abc", "abXc", { budget })).toBe("abXc");
	});

	it("見比べるまでもないとき(片方しか変えていない、両方が同じ本文にした)は、手間を引かない", () => {
		const budget = { chars: 1000, cells: 1000 };

		expect(mergeText("abc", "abc", "abXc", { budget })).toBe("abXc");
		expect(mergeText("abc", "abXc", "abc", { budget })).toBe("abXc");
		expect(mergeText("abc", "abXc", "abXc", { budget })).toBe("abXc");
		expect(budget).toEqual({ chars: 1000, cells: 1000 });
	});

	it("見比べる本文の量が、上限とちょうど同じなら、統合する", () => {
		const budget = { chars: 11, cells: 1000 };

		expect(mergeText("abc", "aXbc", "abYc", { budget })).toBe("aXbYc");
		expect(budget.chars).toBe(0);
	});

	it("細かく見比べる範囲の大きさが、残りとちょうど同じなら、細かく見比べる", () => {
		const budget = { chars: 1000, cells: 6 };

		expect(mergeText("abcde", "abXYZe", "abcdeQ", { budget })).toBe("abXYZeQ");
		expect(budget.cells).toBe(0);
	});

	it("両方の範囲を細かく見比べたら、両方の大きさを引く。あとから届いた側も、残りの範囲で見比べる", () => {
		// current は「cd」と「XYZ」(2 × 3)、incoming は「b」と「QR」(1 × 2)。
		const enough = { chars: 1000, cells: 100 };
		expect(mergeText("abcde", "abXYZe", "aQRcde", { budget: enough })).toBe("aQRXYZe");
		expect(enough.cells).toBe(100 - 6 - 2);

		// current を見比べると、残りは 1。incoming の範囲(2)は、まるごと置き換えたものとして扱う。
		const short = { chars: 1000, cells: 7 };
		mergeText("abcde", "abXYZe", "aQRcde", { budget: short });
		expect(short.cells).toBe(1);
	});

	it("上限を渡さなくても、1回に細かく見比べる範囲には上限がある。超えたら、範囲をまるごと置き換えたものとして扱う", () => {
		// 先頭と末尾だけを変えた、1100文字の本文。見比べる範囲は 1100 × 1100 で、上限(100万)を超える。
		const base = Array.from({ length: 1100 }, (_, index) => String.fromCodePoint(0x4e00 + index));
		const current = ["先", ...base.slice(1, -1), "末"].join("");
		const incoming = base.filter((_, index) => index !== 500).join("");

		// current は「全部を消して、全部を足した」とみなすので、incoming が消した文字も、current の中に残る。
		expect(mergeText(base.join(""), current, incoming)).toBe(current);
	});
});

describe("mapColumn", () => {
	it("本文が変わっていなければ、同じ位置", () => {
		expect(mapColumn("abc", "abc", 2)).toBe(2);
	});

	it("手前に文字が足されたら、その分だけ後ろにずれる", () => {
		expect(mapColumn("abc", "XYabc", 2)).toBe(4);
		expect(mapColumn("abc", "aXbc", 3)).toBe(4);
	});

	it("後ろに文字が足されても、ずれない", () => {
		expect(mapColumn("abc", "abcX", 2)).toBe(2);
		expect(mapColumn("abc", "abXc", 1)).toBe(1);
	});

	it("ちょうどその位置に文字が足されたら、足された文字の前にとどまる", () => {
		expect(mapColumn("abc", "abXc", 2)).toBe(2);
		expect(mapColumn("abc", "abcX", 3)).toBe(3);
		expect(mapColumn("", "X", 0)).toBe(0);
	});

	it("手前の文字が消されたら、その分だけ前にずれる", () => {
		expect(mapColumn("abcd", "acd", 3)).toBe(2);
	});

	it("消された範囲の中にあったら、消された場所に寄る", () => {
		expect(mapColumn("abcdef", "af", 3)).toBe(1);
		expect(mapColumn("abc", "", 2)).toBe(0);
	});

	it("手前の文字が置き換えられたら、置き換えたあとの長さに合わせてずれる", () => {
		expect(mapColumn("猫が好き", "子犬が好き", 2)).toBe(3);
	});

	it("位置は UTF-16 の単位で数える", () => {
		expect(mapColumn("a😀b", "X😀a😀b", 3)).toBe(6);
		expect(mapColumn("a😀b", "ab", 3)).toBe(1);
	});

	it("文字の途中の位置は、その文字の中での位置を保つ(文字が消されていたら、消された場所)", () => {
		expect(mapColumn("a😀b", "Xa😀b", 2)).toBe(3);
		expect(mapColumn("a😀b", "ab", 2)).toBe(1);
	});

	it("本文より後ろの位置は、末尾の位置として扱う", () => {
		expect(mapColumn("abc", "abcd", 10)).toBe(3);
		expect(mapColumn("abc", "Xab", 10)).toBe(3);
	});

	it("結果は、いつも変わったあとの本文の範囲に収まる", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), fc.nat(40), (before, after, column) => {
				const mapped = mapColumn(before, after, column);
				expect(mapped).toBeGreaterThanOrEqual(0);
				expect(mapped).toBeLessThanOrEqual(after.length);
			}),
		);
	});
});
