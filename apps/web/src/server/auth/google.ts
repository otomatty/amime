import { readIdentity } from "@amime/shared";
import { decodeJsonSegment } from "./crypto.ts";
import type { LoginProvider } from "./provider.types.ts";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Google が IDトークンの発行者として名乗る値(スキームの付かない形も使われる)。 */
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** トークンの受け渡し口が返したものから、IDトークンの中身を取り出す。 */
async function idTokenClaims(response: Response): Promise<unknown> {
	if (!response.ok) return null;
	const body: unknown = await response.json().catch(() => null);
	const token =
		typeof body === "object" && body !== null && "id_token" in body ? body.id_token : null;
	if (typeof token !== "string") return null;
	const segments = token.split(".");
	return segments.length === 3 ? decodeJsonSegment(segments[1] ?? "") : null;
}

/**
 * Google でのログイン。クライアントIDとシークレットがなければ、使えない(null)。
 *
 * IDトークンは、Google のトークンの受け渡し口から、TLS で直接受け取る。
 * そのため、署名は確かめず、発行者・宛先・期限・合言葉を確かめる(OpenID Connect Core 3.1.3.7 が認めるやり方)。
 */
export function googleProvider(env: {
	readonly GOOGLE_CLIENT_ID?: string;
	readonly GOOGLE_CLIENT_SECRET?: string;
}): LoginProvider | null {
	const clientId = env.GOOGLE_CLIENT_ID ?? "";
	const clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
	if (clientId === "" || clientSecret === "") return null;
	return {
		authorizeUrl({ state, nonce, challenge, redirectUri }) {
			const query = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: "openid email profile",
				state,
				nonce,
				code_challenge: challenge,
				code_challenge_method: "S256",
			});
			return `${AUTHORIZE_URL}?${query}`;
		},
		async identify({ code, verifier, nonce, redirectUri, now }) {
			const response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					code_verifier: verifier,
					client_id: clientId,
					client_secret: clientSecret,
					redirect_uri: redirectUri,
				}).toString(),
			}).catch(() => null);
			if (response === null) return null;
			const identity = readIdentity(await idTokenClaims(response), {
				issuers: ISSUERS,
				audience: clientId,
				nonce,
				now: Math.floor(now / 1000),
			});
			return identity.ok ? identity.value : null;
		},
	};
}
