import "server-only";

/**
 * Reads `iat` and `exp` from a portal session token's payload, for display
 * only ("Signed in until 6:40 PM", "Stays signed in for 8 hours"). It does
 * not verify the signature: only call it on a token Convex already accepted,
 * or to describe a token that just stopped working.
 */
export function readSessionTokenTimes(token: string) {
	const [body] = token.split(".");
	if (!body) return null;
	try {
		const payload: unknown = JSON.parse(
			Buffer.from(body, "base64url").toString("utf8"),
		);
		if (
			typeof payload !== "object" ||
			payload === null ||
			!("iat" in payload) ||
			!("exp" in payload) ||
			typeof payload.iat !== "number" ||
			typeof payload.exp !== "number" ||
			payload.exp <= payload.iat
		) {
			return null;
		}
		return {
			expiresAt: payload.exp * 1000,
			ttlSeconds: payload.exp - payload.iat,
		};
	} catch {
		return null;
	}
}
