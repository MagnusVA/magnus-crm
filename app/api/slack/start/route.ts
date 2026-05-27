import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";

import { api } from "@/convex/_generated/api";

function describeRequestUrl(request: NextRequest) {
  return {
    pathname: request.nextUrl.pathname,
    searchParamNames: Array.from(request.nextUrl.searchParams.keys()).sort(),
  };
}

function describeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return {
      host: url.host,
      pathname: url.pathname,
      searchParamNames: Array.from(url.searchParams.keys()).sort(),
    };
  } catch {
    return { invalid: true };
  }
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Unknown", message: String(error) };
}

function getConvexUrl() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("Missing NEXT_PUBLIC_CONVEX_URL");
  }
  return convexUrl;
}

function redirectTo(request: NextRequest, path: string) {
  return NextResponse.redirect(new URL(path, request.url));
}

export async function GET(request: NextRequest) {
  const requestId = globalThis.crypto.randomUUID();

  console.log("[Slack:OAuth:Next] start route received", {
    requestId,
    ...describeRequestUrl(request),
  });

  let auth: Awaited<ReturnType<typeof withAuth>>;
  try {
    auth = await withAuth({ ensureSignedIn: true });
  } catch (error) {
    console.error("[Slack:OAuth:Next] auth resolution failed", {
      requestId,
      error: describeError(error),
    });
    throw error;
  }

  console.log("[Slack:OAuth:Next] auth resolved", {
    requestId,
    hasUser: Boolean(auth.user),
    hasAccessToken: Boolean(auth.accessToken),
  });

  if (!auth.user || !auth.accessToken) {
    console.warn("[Slack:OAuth:Next] redirecting unauthenticated request", {
      requestId,
      destination: "/sign-in",
    });
    return redirectTo(request, "/sign-in");
  }

  const convexUrl = getConvexUrl();
  console.log("[Slack:OAuth:Next] preparing Convex action", {
    requestId,
    convexUrl: describeExternalUrl(convexUrl),
  });

  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(auth.accessToken);

  try {
    const { authorizeUrl } = await convex.action(
      api.slack.oauth.startInstall,
      { requestId },
    );

    const parsedAuthorizeUrl = new URL(authorizeUrl);
    console.log("[Slack:OAuth:Next] redirecting to Slack authorize", {
      requestId,
      authorizeHost: parsedAuthorizeUrl.host,
      authorizePathname: parsedAuthorizeUrl.pathname,
      hasClientId: parsedAuthorizeUrl.searchParams.has("client_id"),
      hasRedirectUri: parsedAuthorizeUrl.searchParams.has("redirect_uri"),
      hasState: parsedAuthorizeUrl.searchParams.has("state"),
      scopeCount:
        parsedAuthorizeUrl.searchParams.get("scope")?.split(",").filter(Boolean)
          .length ?? 0,
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("[Slack:OAuth:Next] startInstall failed", {
      requestId,
      error: describeError(error),
    });

    if (message.includes("Insufficient permissions")) {
      console.warn("[Slack:OAuth:Next] redirecting admin-required failure", {
        requestId,
        destination: "/workspace?slack=admin_required",
      });
      return redirectTo(request, "/workspace?slack=admin_required");
    }

    console.warn("[Slack:OAuth:Next] redirecting start failure", {
      requestId,
      destination: "/workspace/settings?tab=integrations&slack=start_failed",
    });
    return redirectTo(
      request,
      "/workspace/settings?tab=integrations&slack=start_failed",
    );
  }
}
