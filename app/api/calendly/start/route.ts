import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

function getConvexUrl() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("Missing NEXT_PUBLIC_CONVEX_URL");
  }
  return convexUrl;
}

function normalizeReturnTo(returnTo: string | null) {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return "/onboarding/connect";
  }

  return returnTo;
}

function isOnboardingConnectPath(pathname: string) {
  return pathname === "/onboarding/connect";
}

function redirectToReturnTarget(
  request: NextRequest,
  returnTo: string,
  error: string,
) {
  const url = new URL(returnTo, request.url);
  url.searchParams.set(
    isOnboardingConnectPath(url.pathname) ? "error" : "calendlyError",
    error,
  );
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const returnTo = normalizeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );
  const auth = await withAuth({ ensureSignedIn: true });
  if (!auth.user || !auth.accessToken) {
    return redirectToReturnTarget(request, returnTo, "not_authenticated");
  }

  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) {
    return redirectToReturnTarget(request, returnTo, "missing_context");
  }

  const convex = new ConvexHttpClient(getConvexUrl());
  convex.setAuth(auth.accessToken);

  try {
    if (request.nextUrl.searchParams.get("mode") === "reconnect") {
      await convex.action(api.calendly.oauth.prepareReconnect, {
        tenantId: tenantId as Id<"tenants">,
      });
    }

    const { authorizeUrl } = await convex.action(api.calendly.oauth.startOAuth, {
      tenantId: tenantId as Id<"tenants">,
    });

    const response = NextResponse.redirect(authorizeUrl);
    response.cookies.set("onboarding_tenantId", tenantId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 15,
    });
    response.cookies.set("calendly_returnTo", returnTo, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 15,
    });
    return response;
  } catch {
    return redirectToReturnTarget(request, returnTo, "oauth_start_failed");
  }
}
