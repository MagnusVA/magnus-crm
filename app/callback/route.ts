import { type NextRequest, NextResponse } from "next/server";
import {
  getWorkOS,
  handleAuth,
  saveSession,
} from "@workos-inc/authkit-nextjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOnboardingOrgId(state: string | undefined) {
  if (!state) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(state) as { onboardingOrgId?: unknown };
    return typeof parsed.onboardingOrgId === "string"
      ? parsed.onboardingOrgId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect whether this callback originated from a WorkOS invitation email
 * rather than from our app's normal sign-in / sign-up flow.
 *
 * Normal flow: getSignInUrl/getSignUpUrl stores a PKCE cookie
 * (`wos-auth-verifier`) and appends a `state` param. Both are expected
 * on the callback.
 *
 * Invitation flow: The user clicks an email link that goes directly to
 * WorkOS AuthKit, so there is no app-generated `state` param to validate
 * against. A stale PKCE cookie can still exist in the browser from a prior
 * auth attempt, so absence of the cookie is not reliable here.
 */
function isInvitationCallback(request: NextRequest): boolean {
  const hasCode = request.nextUrl.searchParams.has("code");
  const hasState = request.nextUrl.searchParams.has("state");

  // Invitation callbacks arrive with a code but without app-managed state.
  return hasCode && !hasState;
}

/**
 * Get the redirect URI for this environment.
 */
function getRedirectUri(): string {
  return (
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
    "http://localhost:3000/callback"
  );
}

// ---------------------------------------------------------------------------
// Invitation callback handler
//
// When a user accepts a WorkOS invitation email, the callback arrives
// with only `code` and no app-managed `state` param. A stale PKCE cookie
// can still exist in the browser, so handleAuth() would misclassify this
// request and fail before a session is established.
//
// Instead we exchange the code directly using the confidential-client
// flow (API key authenticates the exchange instead of PKCE), save the
// session, and redirect to /workspace where claimInvitedAccount will
// link the CRM record.
// ---------------------------------------------------------------------------

async function handleInvitationCallback(
  request: NextRequest,
): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code")!;
  const workos = getWorkOS();
  const hadPkceCookie = request.cookies.has("wos-auth-verifier");

  console.log("[AuthDebug:Callback] invitation callback detected", {
    code: `${code.slice(0, 8)}...`,
    hadPkceCookie,
  });

  // Exchange the authorization code. No codeVerifier needed — the server
  // API key acts as the client secret (confidential client flow).
  const authResponse = await workos.userManagement.authenticateWithCode({
    clientId: process.env.WORKOS_CLIENT_ID!,
    code,
  });

  console.log("[AuthDebug:Callback] invitation auth response", {
    userId: authResponse.user.id,
    email: authResponse.user.email,
    organizationId: authResponse.organizationId ?? null,
    hasAccessToken: Boolean(authResponse.accessToken),
    hasRefreshToken: Boolean(authResponse.refreshToken),
  });

  // The user accepted an org invitation, so organizationId should be set.
  // If not, we still save the session and let the workspace handle it.
  let finalSession = authResponse;

  if (authResponse.organizationId && authResponse.refreshToken) {
    // Refresh the session scoped to the organization so the JWT includes
    // org claims (organization_id, role, permissions). The initial auth
    // response may not include them if the invitation acceptance happened
    // in the same step.
    try {
      const refreshed = await workos.userManagement.authenticateWithRefreshToken({
        clientId: process.env.WORKOS_CLIENT_ID!,
        refreshToken: authResponse.refreshToken,
        organizationId: authResponse.organizationId,
      });

      console.log("[AuthDebug:Callback] invitation session refreshed with org context", {
        userId: refreshed.user.id,
        organizationId: authResponse.organizationId,
      });

      finalSession = {
        ...refreshed,
        organizationId: authResponse.organizationId,
      };
    } catch (error) {
      console.warn("[AuthDebug:Callback] org-scoped refresh failed, using initial session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Save the session cookie
  await saveSession(
    {
      accessToken: finalSession.accessToken,
      refreshToken: finalSession.refreshToken,
      user: finalSession.user,
      impersonator: finalSession.impersonator,
    },
    getRedirectUri(),
  );

  console.log("[AuthDebug:Callback] invitation session saved, redirecting to /workspace", {
    userId: finalSession.user.id,
    organizationId: authResponse.organizationId ?? null,
  });

  // Redirect to workspace — claimInvitedAccount will link the CRM record
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const response = NextResponse.redirect(new URL("/workspace", appUrl));

  // Clean up any stale PKCE verifier so it cannot interfere with later auth flows.
  response.cookies.delete("wos-auth-verifier");

  return response;
}

// ---------------------------------------------------------------------------
// Main callback handler
// ---------------------------------------------------------------------------

const standardAuthHandler = handleAuth({
  onSuccess: async ({
    refreshToken,
    user,
    organizationId,
    state,
  }) => {
    const onboardingOrgId = getOnboardingOrgId(state);
    // #region agent log
    fetch("http://127.0.0.1:7558/ingest/9b7221bc-3886-480d-9572-12346f2530bc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "78a0ba",
      },
      body: JSON.stringify({
        sessionId: "78a0ba",
        runId: "initial",
        hypothesisId: "H2",
        location: "app/callback/route.ts:169",
        message: "callback onSuccess received auth context",
        data: {
          hasRefreshToken: Boolean(refreshToken),
          hasState: Boolean(state),
          organizationId: organizationId ?? null,
          onboardingOrgId: onboardingOrgId ?? null,
          hasUser: Boolean(user),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    console.log("[AuthDebug:Callback] onSuccess", {
      userId: user.id,
      email: user.email,
      organizationId: organizationId ?? null,
      onboardingOrgId: onboardingOrgId ?? null,
      hasRefreshToken: Boolean(refreshToken),
    });

    if (!organizationId && onboardingOrgId) {
      const workos = getWorkOS();
      const memberships = await workos.userManagement.listOrganizationMemberships(
        {
          organizationId: onboardingOrgId,
          userId: user.id,
        },
      );

      const existingMembership = memberships.data[0];
      console.log("[AuthDebug:Callback] membership lookup", {
        userId: user.id,
        onboardingOrgId,
        membershipCount: memberships.data.length,
        existingMembershipId: existingMembership?.id ?? null,
      });
      if (!existingMembership) {
        try {
          await workos.userManagement.createOrganizationMembership({
            organizationId: onboardingOrgId,
            userId: user.id,
          });
          console.log("[AuthDebug:Callback] membership created", {
            userId: user.id,
            onboardingOrgId,
          });
        } catch (error) {
          console.error("[callback] Failed to create org membership:", error);
          // Don't fail the auth callback; the user can retry login
        }
      }

      const refreshedSession =
        await workos.userManagement.authenticateWithRefreshToken({
          clientId: process.env.WORKOS_CLIENT_ID!,
          refreshToken,
          organizationId: onboardingOrgId,
        });

      console.log("[AuthDebug:Callback] refreshed session", {
        requestedOrganizationId: onboardingOrgId,
        refreshedUserId: refreshedSession.user.id,
        refreshedOrganizationId: onboardingOrgId,
        hasAccessToken: Boolean(refreshedSession.accessToken),
        hasRefreshToken: Boolean(refreshedSession.refreshToken),
      });

      await saveSession(
        {
          accessToken: refreshedSession.accessToken,
          refreshToken: refreshedSession.refreshToken,
          user: refreshedSession.user,
          impersonator: refreshedSession.impersonator,
        },
        process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/callback",
      );

      console.log("[AuthDebug:Callback] session saved", {
        userId: refreshedSession.user.id,
        organizationId: onboardingOrgId,
      });
      return;
    }

    console.log("[AuthDebug:Callback] session retained", {
      userId: user.id,
      organizationId: organizationId ?? null,
      usedOnboardingOrgFallback: false,
    });
  },
});

export async function GET(request: NextRequest) {
  // Invitation callbacks bypass handleAuth because they lack app-managed
  // state, even if a stale PKCE cookie is still present in the browser.
  if (isInvitationCallback(request)) {
    try {
      return await handleInvitationCallback(request);
    } catch (error) {
      console.error("[AuthDebug:Callback] invitation callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall through to standard handler as last resort
    }
  }

  // Standard PKCE-based callback (sign-in, sign-up, tenant onboarding)
  return standardAuthHandler(request);
}
