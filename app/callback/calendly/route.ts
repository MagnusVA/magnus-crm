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

function getConvexSiteUrl() {
  const convexSiteUrl =
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL?.replace(".convex.cloud", ".convex.site");
  if (!convexSiteUrl) {
    throw new Error("Missing NEXT_PUBLIC_CONVEX_SITE_URL");
  }
  return convexSiteUrl;
}

function normalizeReturnTo(returnTo: string | null | undefined) {
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
  params: Record<string, string>,
  clearTenantCookie = true,
) {
  const returnTo = normalizeReturnTo(
    request.cookies.get("calendly_returnTo")?.value,
  );
  const url = new URL(returnTo, request.url);
  const isOnboardingReturn = isOnboardingConnectPath(url.pathname);

  for (const [key, value] of Object.entries(params)) {
    if (!isOnboardingReturn && key === "error") {
      url.searchParams.set("calendlyError", value);
      continue;
    }
    url.searchParams.set(key, value);
  }

  const response = NextResponse.redirect(url);
  if (clearTenantCookie) {
    response.cookies.delete("onboarding_tenantId");
  }
  response.cookies.delete("calendly_returnTo");
  return response;
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  const code = request.nextUrl.searchParams.get("code");

  if (error || !code) {
    return redirectToReturnTarget(request, {
      error: error ?? "calendly_denied",
    });
  }

  const tenantId = request.cookies.get("onboarding_tenantId")?.value;
  if (!tenantId) {
    return redirectToReturnTarget(request, { error: "missing_context" });
  }

  const auth = await withAuth({ ensureSignedIn: true });
  if (!auth.user || !auth.accessToken) {
    return redirectToReturnTarget(
      request,
      { error: "not_authenticated" },
      false,
    );
  }

  const convex = new ConvexHttpClient(getConvexUrl());
  convex.setAuth(auth.accessToken);

  try {
    await convex.action(api.calendly.oauth.exchangeCodeAndProvision, {
      tenantId: tenantId as Id<"tenants">,
      code,
      convexSiteUrl: getConvexSiteUrl(),
    });

    return redirectToReturnTarget(request, { calendly: "connected" });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "exchange_failed";

    // Map specific error messages to user-friendly error codes
    let errorCode: string;
    if (errorMessage.includes("code verifier")) {
      // Concurrent OAuth flow: session expired or started in another tab
      errorCode = "stale_session";
    } else if (errorMessage === "calendly_free_plan_unsupported") {
      errorCode = "calendly_free_plan_unsupported";
    } else if (errorMessage.startsWith("webhook_creation_failed")) {
      errorCode = "webhook_creation_failed";
    } else {
      errorCode = "exchange_failed";
    }

    return redirectToReturnTarget(request, { error: errorCode });
  }
}
