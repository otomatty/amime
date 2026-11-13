import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mapColumn, mergeText } from "./merge-text.ts";

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
	it("本文を見比べる手間が上限を超えたら、統合せずに、あとから届いた本文にする", () => {
		const budget = { remaining: 10 };

		expect(mergeText("今日は晴れ", "今日は晴れです", "たぶん今日は晴れ", { budget })).toBe(
			"たぶん今日は晴れ",
		);
	});

	it("統合するたびに、使った手間を上限から引く", () => {
		const budget = { remaining: 1000 };

		mergeText("abc", "aXbc", "abYc", { budget });

		// 3つの本文の長さ(3 + 4 + 4)。変わった範囲に、見比べる文字はない。
		expect(budget.remaining).toBe(1000 - 11);
	});

	it("変わった範囲を細かく見比べる手間が残っていなければ、範囲をまるごと置き換えたものとして統合する", () => {
		const budget = { remaining: 20 };

		// 「cd」と「XYZ」を見比べる手間(2 × 3)は、残り(20 - 17)を超える。
		expect(mergeText("abcde", "abXYZe", "abcdeQ", { budget })).toBe("abXYZeQ");
		expect(budget.remaining).toBe(3);
	});

	it("片方しか変えていなければ、手間を使わない", () => {
		const budget = { remaining: 0 };

		expect(mergeText("abc", "abc", "abXc", { budget })).toBe("abXc");
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
