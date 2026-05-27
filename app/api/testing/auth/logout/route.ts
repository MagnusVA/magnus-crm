import { type NextRequest, NextResponse } from "next/server";
import {
	getE2EAllowedOrigins,
	isE2EEnabled,
} from "@/lib/testing/e2e-auth";

// ---------------------------------------------------------------------------
// Test-only AuthKit logout
//
// Clears the WorkOS session cookie and redirects to `/`. Useful when an agent
// needs to switch roles inside a single browser context. Prefer creating a
// fresh browser context per role when possible (Playwright newContext()).
//
// Returns 404 when E2E auth is disabled. See `lib/testing/e2e-auth.ts`.
// ---------------------------------------------------------------------------

function notFound(): NextResponse {
	return new NextResponse("Not found", { status: 404 });
}

function isOriginAllowed(request: NextRequest): boolean {
	return getE2EAllowedOrigins().includes(request.nextUrl.origin);
}

export function GET(request: NextRequest): NextResponse {
	if (!isE2EEnabled()) {
		return notFound();
	}
	if (!isOriginAllowed(request)) {
		return notFound();
	}

	const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
	const response = NextResponse.redirect(new URL("/", appUrl));

	const cookieName = process.env.WORKOS_COOKIE_NAME ?? "wos-session";
	response.cookies.delete(cookieName);

	return response;
}
