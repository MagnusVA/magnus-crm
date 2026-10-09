import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorCode } from "@/lib/errors";
import { reportServerError } from "@/lib/observability/report-server-error";

/**
 * OAuth 2.0 error codes (RFC 6749 §4.1.2.1). The `error` param is
 * caller-controlled, so anything else is reported as `other` to keep the
 * fingerprint low-cardinality.
 */
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

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

  if (error && error !== "access_denied") {
    // Calendly refused the authorization; the user sees the error and can retry.
    const oauthError = OAUTH_ERROR_CODES.has(error) ? error : "other";
    await reportServerError(
      new Error(`Calendly OAuth authorize failed (${oauthError})`),
      {
        event: "calendly.oauth_callback.denied",
        request,
        integration: "calendly",
        expected: true,
        severity: "warning",
        fingerprint: `calendly-oauth-callback:${oauthError}`,
        error_code: oauthError,
      },
    );
  }

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
    // Expected rejections carry a stable code (`ConvexError` data); plain
    // Error messages are redacted in production, so only codes are reliable.
    const backendCode = getErrorCode(error);
    const errorMessage = error instanceof Error ? error.message : "";

    // Map backend codes to the error keys the return page understands
    let errorCode: string;
    if (backendCode === "calendly.oauth_flow_expired") {
      // Missing or reused PKCE verifier: expired, or started in another tab
      errorCode = "stale_session";
    } else if (backendCode === "calendly.tenant_not_ready") {
      errorCode = "missing_context";
    } else if (backendCode?.startsWith("auth.")) {
      errorCode = "not_authenticated";
    } else if (getErrorCode(error) === "calendly.free_plan_unsupported") {
      errorCode = "calendly_free_plan_unsupported";
    } else if (errorMessage.startsWith("webhook_creation_failed")) {
      errorCode = "webhook_creation_failed";
    } else {
      errorCode = "exchange_failed";
    }

    await reportServerError(error, {
      event: "calendly.oauth_exchange.failed",
      request,
      distinctId: auth.user.id,
      fingerprint: `calendly-oauth-exchange:${errorCode}`,
      error_code: errorCode,
    });

    return redirectToReturnTarget(request, { error: errorCode });
  }
}
