/** 戻る場所として受け取る長さの上限。 */
const MAX_RETURN_PATH = 1_000;
/** このサイトの中のパス。「/」で始まり、2文字目は「/」でも「\」でもない(他のサイトを指さない)。 */
const LOCAL_PATH = /^\/(?![/\\])[^\\\p{Cc}]*$/u;

/**
 * ログインのあとに戻る場所。このサイトの中のパスだけを認め、ほかはトップに戻す
 * (ログインのリンクを使って、他のサイトへ送り出されないようにする)。
 */
export function safeReturnPath(value: string | undefined): string {
	if (value === undefined || value.length > MAX_RETURN_PATH) return "/";
	return LOCAL_PATH.test(value) ? value : "/";
}
