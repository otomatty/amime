/** 戻る場所として受け取る長さの上限。 */
const MAX_RETURN_PATH = 1_000;
/**
 * このサイトの中のパス。「/」で始まり、2文字目は「/」でも「\」でもない(他のサイトを指さない)。
 * URLのパスは、符号化されていれば ASCII の表示できる文字だけになる。それ以外は認めない
 * (文字数の上限で、Cookie に入れたときの大きさも抑えられる)。
 */
const LOCAL_PATH = /^\/(?![/\\])[!-[\]-~]*$/;

/**
 * ログインのあとに戻る場所。このサイトの中のパスだけを認め、ほかはトップに戻す
 * (ログインのリンクを使って、他のサイトへ送り出されないようにする)。
 */
export function safeReturnPath(value: string | undefined): string {
	if (value === undefined || value.length > MAX_RETURN_PATH) return "/";
	return LOCAL_PATH.test(value) ? value : "/";
}
