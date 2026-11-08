"use client";

import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-nextjs/components";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache/provider";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import posthog from "@/lib/posthog-browser";
import { toast } from "sonner";
import { CalendlyConnectionGuard } from "@/components/calendly-connection-guard";
import { SlackConnectionGuard } from "@/components/slack-connection-guard";
import { isPostHogEnabled } from "@/lib/posthog-config";

/**
 * A failing refresh repeats on every Convex reconnect, so the PostHog log
 * line is sent once per page session.
 */
let loggedTokenRefreshFailure = false;

function logTokenRefreshFailure(forced: boolean) {
  if (loggedTokenRefreshFailure || !isPostHogEnabled()) return;
  loggedTokenRefreshFailure = true;
  try {
    posthog.logger.warn("auth.token_refresh_failed", { forced });
  } catch {
    // Never let reporting break auth.
  }
}

function showSessionExpiredToast() {
  toast.error("Your session has expired. Please sign in again.", {
    // Convex asks again after a failure; keep one toast on screen.
    id: "session-expired",
    action: {
      label: "Sign In",
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- /sign-in is a route handler and needs a full page load
      onClick: () => window.location.assign("/sign-in"),
    },
    duration: Infinity, // Don't auto-dismiss — user must act
  });
}

/** Waits before each retry of a token request that failed on the network or with a 5xx. */
const TOKEN_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Asks the token route, retrying network failures and 5xx responses: Convex
 * treats a null token as signed out until the page reloads.
 */
async function requestAccessToken(force: boolean): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const retryDelay = TOKEN_RETRY_DELAYS_MS[attempt];
    try {
      const response = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
        cache: "no-store",
      });
      if (response.status < 500 || retryDelay === undefined) return response;
    } catch (error) {
      if (retryDelay === undefined) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
}

function getConvexUrl(): string {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "Missing NEXT_PUBLIC_CONVEX_URL. Run `pnpm convex:dev` and copy the deployment URL into .env.local.",
    );
  }
  return url;
}

// One client per page, built at module scope: building it during render calls
// Math.random(), which stops the static shell from prerendering. The client
// opens its WebSocket on first use, so nothing connects on the server.
// initialAuthTokenReuse: keep the page-load token and refresh it before it
// expires, instead of forcing a second token right after connecting.
const convex = new ConvexReactClient(getConvexUrl(), { initialAuthTokenReuse: true });

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    // onSessionExpired={false} stops AuthKit's checkSessionAction POST on
    // every tab focus. A failed token request below shows the expiry toast.
    <AuthKitProvider onSessionExpired={false}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {/* For the convex-helpers cached useQuery: a component that uses it
            gets its last result at once when it mounts again within minutes. */}
        <ConvexQueryCacheProvider>
          <CalendlyConnectionGuard>
            <SlackConnectionGuard>
              {children}
            </SlackConnectionGuard>
          </CalendlyConnectionGuard>
        </ConvexQueryCacheProvider>
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}

function useAuthFromAuthKit() {
  const { user, loading: isLoading } = useAuth();
  const wasAuthenticatedRef = useRef(false);

  const isAuthenticated = !!user;

  // Detect session expiry when authenticated user becomes unauthenticated
  useEffect(() => {
    if (isAuthenticated) {
      wasAuthenticatedRef.current = true;
    } else if (wasAuthenticatedRef.current && !isAuthenticated && !isLoading) {
      // Session expired — was authenticated, now isn't
      showSessionExpiredToast();
      wasAuthenticatedRef.current = false;
    }
  }, [isAuthenticated, isLoading]);

  // Tokens come from a Route Handler, not AuthKit's useAccessToken(): its
  // refresh is a server action, and each one cleared the router's prefetch
  // cache and re-rendered the page (app/api/auth/token/route.ts). Convex asks
  // with forceRefreshToken shortly before the token expires.
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      const forced = Boolean(forceRefreshToken);
      try {
        const response = await requestAccessToken(forced);
        if (response.status === 401) {
          showSessionExpiredToast();
          return null;
        }
        if (!response.ok) {
          throw new Error(`Token request failed with status ${response.status}`);
        }
        const { accessToken } = (await response.json()) as { accessToken?: string | null };
        return accessToken ?? null;
      } catch (error) {
        console.error("Failed to get access token:", error);
        logTokenRefreshFailure(forced);
        return null;
      }
    },
    [user],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}
