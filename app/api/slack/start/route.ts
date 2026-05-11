import { withAuth } from "@workos-inc/authkit-nextjs";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";

import { api } from "@/convex/_generated/api";

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
  const auth = await withAuth({ ensureSignedIn: true });
  if (!auth.user || !auth.accessToken) {
    return redirectTo(request, "/sign-in");
  }

  const convex = new ConvexHttpClient(getConvexUrl());
  convex.setAuth(auth.accessToken);

  try {
    const { authorizeUrl } = await convex.action(
      api.slack.oauth.startInstall,
      {},
    );
    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error("[/api/slack/start] startInstall failed", { message });

    if (message.includes("Insufficient permissions")) {
      return redirectTo(request, "/workspace?slack=admin_required");
    }

    return redirectTo(
      request,
      "/workspace/settings?tab=integrations&slack=start_failed",
    );
  }
}
