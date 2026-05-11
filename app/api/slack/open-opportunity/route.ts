import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

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

function redirectWithSlackOpen(
  request: NextRequest,
  path: string,
  reason: string,
) {
  const url = new URL(path, request.url);
  url.searchParams.set("slackOpen", reason);
  return NextResponse.redirect(url);
}

function signInRedirect(request: NextRequest) {
  const url = new URL("/sign-in", request.url);
  url.searchParams.set(
    "returnTo",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const opportunityId = request.nextUrl.searchParams.get("opportunityId");
  if (!opportunityId) {
    return redirectWithSlackOpen(request, "/workspace", "invalid_opportunity");
  }

  const auth = await withAuth();
  if (!auth.user || !auth.accessToken) {
    return signInRedirect(request);
  }

  if (auth.organizationId === SYSTEM_ADMIN_ORG_ID) {
    return redirectWithSlackOpen(request, "/admin", "system_admin");
  }

  const convex = new ConvexHttpClient(getConvexUrl());
  convex.setAuth(auth.accessToken);

  try {
    const resolution = await convex.query(
      api.slack.deepLinks.resolveOpportunityOpen,
      { opportunityId: opportunityId as Id<"opportunities"> },
    );

    if (resolution.kind === "open") {
      return redirectTo(request, resolution.path);
    }

    return redirectWithSlackOpen(
      request,
      resolution.fallbackPath,
      resolution.reason,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.warn("[/api/slack/open-opportunity] redirect failed", {
      message,
    });
    return redirectWithSlackOpen(request, "/workspace", "invalid_opportunity");
  }
}
