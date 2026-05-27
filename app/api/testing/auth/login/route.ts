import { type NextRequest, NextResponse } from "next/server";
import { getWorkOS, saveSession } from "@workos-inc/authkit-nextjs";
import {
	getConfiguredE2EOrgId,
	getE2EAllowedOrigins,
	getE2EEmailForRole,
	isE2EEnabled,
	verifyE2ELoginToken,
} from "@/lib/testing/e2e-auth";

// ---------------------------------------------------------------------------
// Test-only AuthKit session bridge
//
// Exchanges a short-lived signed token for a real WorkOS AuthKit session
// cookie scoped to the configured tenant organization. This is the routine
// used by `scripts/e2e-login-url.mjs` and by Playwright/agent tests.
//
// The route returns 404 when E2E auth is disabled so that it is not
// discoverable in normal app usage. See `lib/testing/e2e-auth.ts` for
// signing/verification details and the security checklist.
// ---------------------------------------------------------------------------

function notFound(): NextResponse {
	return new NextResponse("Not found", { status: 404 });
}

function isOriginAllowed(request: NextRequest): boolean {
	const allowed = getE2EAllowedOrigins();
	return allowed.includes(request.nextUrl.origin);
}

function safeRedirectTarget(
	request: NextRequest,
	returnTo: string,
): URL {
	const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
	// `returnTo` was already validated as app-relative by verifyE2ELoginToken.
	return new URL(returnTo, appUrl);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	// Disabled by default: behave like the route does not exist.
	if (!isE2EEnabled()) {
		return notFound();
	}

	// Belt-and-suspenders: never serve this route in a production-like build
	// even if E2E_AUTH_ENABLED was somehow set. Production deployments must
	// explicitly opt-in via env on a throwaway test deployment.
	if (
		process.env.NODE_ENV === "production" &&
		process.env.E2E_AUTH_ENABLED !== "1"
	) {
		return notFound();
	}

	if (!isOriginAllowed(request)) {
		console.warn("[E2EAuth] login rejected: disallowed origin", {
			origin: request.nextUrl.origin,
		});
		return notFound();
	}

	const token = request.nextUrl.searchParams.get("token");
	if (!token) {
		return new NextResponse("Missing token", { status: 400 });
	}

	let payload;
	try {
		payload = verifyE2ELoginToken(token);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Invalid token";
		console.warn("[E2EAuth] login rejected: token verification failed", {
			error: message,
		});
		return new NextResponse(message, { status: 401 });
	}

	const expectedOrgId = getConfiguredE2EOrgId();
	if (!expectedOrgId) {
		console.error(
			"[E2EAuth] login rejected: E2E_TEST_TENANT_WORKOS_ORG_ID is not configured",
		);
		return new NextResponse(
			"E2E_TEST_TENANT_WORKOS_ORG_ID is not configured",
			{ status: 500 },
		);
	}
	if (payload.orgId !== expectedOrgId) {
		console.warn("[E2EAuth] login rejected: orgId mismatch", {
			payloadOrgId: payload.orgId,
			expectedOrgId,
		});
		return new NextResponse("Invalid E2E organization", { status: 403 });
	}

	let email: string;
	try {
		email = getE2EEmailForRole(payload.role);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to resolve role email";
		console.error("[E2EAuth] login rejected: role email missing", {
			role: payload.role,
			error: message,
		});
		return new NextResponse(message, { status: 500 });
	}

	const password = process.env.TEST_USERS_PASSWORD;
	if (!password) {
		console.error("[E2EAuth] login rejected: TEST_USERS_PASSWORD missing");
		return new NextResponse("Missing TEST_USERS_PASSWORD", { status: 500 });
	}

	const clientId = process.env.WORKOS_CLIENT_ID;
	if (!clientId) {
		console.error("[E2EAuth] login rejected: WORKOS_CLIENT_ID missing");
		return new NextResponse("Missing WORKOS_CLIENT_ID", { status: 500 });
	}

	const workos = getWorkOS();

	let passwordAuth;
	try {
		passwordAuth = await workos.userManagement.authenticateWithPassword({
			clientId,
			email,
			password,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Password auth failed";
		console.error("[E2EAuth] authenticateWithPassword failed", {
			role: payload.role,
			email,
			error: message,
		});
		return new NextResponse(`Password auth failed: ${message}`, {
			status: 401,
		});
	}

	let orgScopedAuth;
	try {
		orgScopedAuth =
			await workos.userManagement.authenticateWithRefreshToken({
				clientId,
				refreshToken: passwordAuth.refreshToken,
				organizationId: payload.orgId,
			});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Org-scoped refresh failed";
		console.error("[E2EAuth] authenticateWithRefreshToken failed", {
			role: payload.role,
			orgId: payload.orgId,
			error: message,
		});
		return new NextResponse(`Org scope failed: ${message}`, {
			status: 403,
		});
	}

	try {
		await saveSession(
			{
				accessToken: orgScopedAuth.accessToken,
				refreshToken: orgScopedAuth.refreshToken,
				user: orgScopedAuth.user,
				impersonator: orgScopedAuth.impersonator,
			},
			request,
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "saveSession failed";
		console.error("[E2EAuth] saveSession failed", { error: message });
		return new NextResponse(`saveSession failed: ${message}`, {
			status: 500,
		});
	}

	console.log("[E2EAuth] login success", {
		role: payload.role,
		userId: orgScopedAuth.user.id,
		orgId: payload.orgId,
		returnTo: payload.returnTo,
	});

	return NextResponse.redirect(safeRedirectTarget(request, payload.returnTo));
}
