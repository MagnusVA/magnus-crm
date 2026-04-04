"use client";

import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { AuthKitProvider, useAccessToken, useAuth } from "@workos-inc/authkit-nextjs/components";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CalendlyConnectionGuard } from "@/components/calendly-connection-guard";

function getConvexUrl(): string {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "Missing NEXT_PUBLIC_CONVEX_URL. Run `pnpm convex:dev` and copy the deployment URL into .env.local.",
    );
  }
  return url;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [convex] = useState(() => new ConvexReactClient(getConvexUrl()));

  return (
    <AuthKitProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        <CalendlyConnectionGuard>
          {children}
        </CalendlyConnectionGuard>
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}

function useAuthFromAuthKit() {
  const { user, loading: isLoading } = useAuth();
  const { getAccessToken, refresh } = useAccessToken();
  const wasAuthenticatedRef = useRef(false);

  const isAuthenticated = !!user;

  // Detect session expiry when authenticated user becomes unauthenticated
  useEffect(() => {
    if (isAuthenticated) {
      wasAuthenticatedRef.current = true;
    } else if (wasAuthenticatedRef.current && !isAuthenticated && !isLoading) {
      // Session expired — was authenticated, now isn't
      toast.error("Your session has expired. Please sign in again.", {
        action: {
          label: "Sign In",
          onClick: () => window.location.assign("/sign-in"),
        },
        duration: Infinity, // Don't auto-dismiss — user must act
      });
      wasAuthenticatedRef.current = false;
    }
  }, [isAuthenticated, isLoading]);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        if (forceRefreshToken) {
          return (await refresh()) ?? null;
        }

        return (await getAccessToken()) ?? null;
      } catch (error) {
        console.error("Failed to get access token:", error);
        return null;
      }
    },
    [user, refresh, getAccessToken],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}
