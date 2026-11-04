import {
	getTokenClaims,
	refreshSession,
	TokenRefreshError,
	withAuth,
} from "@workos-inc/authkit-nextjs";
import { reportServerError } from "@/lib/observability/report-server-error";

// The WorkOS access token for the Convex client, which asks on connect and
// again shortly before the token expires.
//
// This is a Route Handler on purpose. AuthKit's own refresh is a server
// action, and a cookie written inside a server action makes Next clear the
// client's prefetch cache and re-render the current page on the server. Each
// open tab did that every five minutes. A cookie written here does neither.

const NO_STORE = { "Cache-Control": "no-store" };

/** Refresh once the token has less than this left. */
const REFRESH_BEFORE_EXPIRY_SECONDS = 60;

/**
 * A token this new was refreshed by the proxy on this same request. The proxy
 * doesn't update the request's cookie, so refreshing again would spend the
 * refresh token it already used.
 */
const JUST_ISSUED_SECONDS = 30;

function tokenResponse(accessToken: string | null, status = 200) {
	return Response.json({ accessToken }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
	// Browsers that send Fetch Metadata say where the call came from.
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") {
		return new Response(null, { status: 403, headers: NO_STORE });
	}

	const body: unknown = await request.json().catch(() => null);
	const force =
		typeof body === "object" &&
		body !== null &&
		(body as { force?: unknown }).force === true;

	const { user, accessToken } = await withAuth();
	if (!user || !accessToken) {
		return tokenResponse(null, 401);
	}

	const { exp = 0, iat = 0 } = await getTokenClaims(accessToken);
	const now = Date.now() / 1000;
	const nearExpiry = exp - now <= REFRESH_BEFORE_EXPIRY_SECONDS;
	const justIssued = now - iat < JUST_ISSUED_SECONDS;
	if (!nearExpiry && !(force && !justIssued)) {
		return tokenResponse(accessToken);
	}

	try {
		const refreshed = await refreshSession();
		if (!refreshed.user || !refreshed.accessToken) {
			return tokenResponse(null, 401);
		}
		return tokenResponse(refreshed.accessToken);
	} catch (error) {
		// An expired or revoked session is routine. A WorkOS outage isn't,
		// and it shouldn't sign anyone out.
		if (error instanceof TokenRefreshError && error.isTransient) {
			await reportServerError(error, {
				event: "auth.token_refresh.failed",
				request,
				integration: "workos",
				severity: "warning",
				fingerprint: "auth.token_refresh.failed:transient",
			});
			return tokenResponse(null, 503);
		}
		return tokenResponse(null, 401);
	}
}
