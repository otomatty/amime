/** バイト列を、URLに使える Base64 にする(詰め物なし)。 */
function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/** 推測できない値(既定で256ビット)。URLにも Cookie にも、そのまま入れられる。 */
export function randomToken(bytes = 32): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** 値のハッシュ(16進)。保存するのはこちらで、もとの値は保存しない。 */
export async function hashToken(token: string): Promise<string> {
	return [...(await sha256(token))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** PKCE で、ログインの提供元に先に伝える値(秘密のハッシュ)。 */
export async function pkceChallenge(verifier: string): Promise<string> {
	return base64Url(await sha256(verifier));
}

/** URLに使える Base64 で書かれたJSONを読む。読めなければ null。 */
export function decodeJsonSegment(segment: string): unknown {
	try {
		const binary = atob(segment.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		return null;
	}
}
