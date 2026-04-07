import { NextRequest } from "next/server";
import { authkit, handleAuthkitProxy } from "@workos-inc/authkit-nextjs";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

const PUBLIC_PREFIXES = [
	"/sign-in",
	"/sign-up",
	"/callback",
	"/onboarding",
] as const;

function isPublicPath(pathname: string) {
	if (pathname === "/") {
		return true;
	}

	return PUBLIC_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

export default async function proxy(request: NextRequest) {
	const { session, headers, authorizationUrl } = await authkit(request);
	const { pathname } = request.nextUrl;

	if (pathname === "/" && session.user && session.organizationId) {
		if (session.organizationId === SYSTEM_ADMIN_ORG_ID) {
			return handleAuthkitProxy(request, headers, {
				redirect: "/admin",
			});
		}
	}

	// Public paths bypass auth entirely
	if (isPublicPath(pathname)) {
		return handleAuthkitProxy(request, headers);
	}

	// Unauthenticated users on protected paths -> redirect to login
	if (!session.user && authorizationUrl) {
		return handleAuthkitProxy(request, headers, {
			redirect: authorizationUrl,
		});
	}

	// /admin routes: only SYSTEM_ADMIN_ORG_ID users
	if (pathname.startsWith("/admin")) {
		if (session.organizationId !== SYSTEM_ADMIN_ORG_ID) {
			return handleAuthkitProxy(request, headers, {
				redirect: "/workspace",
			});
		}
	}

	// /workspace routes: require any organizationId
	if (pathname.startsWith("/workspace")) {
		if (!session.organizationId) {
			return handleAuthkitProxy(request, headers, {
				redirect: "/sign-in",
			});
		}
	}

	// All other authenticated requests pass through
	return handleAuthkitProxy(request, headers);
}

export const config = {
	matcher: [
		"/((?!_next|ingest|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
