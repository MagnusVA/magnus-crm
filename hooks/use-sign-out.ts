"use client";

import { useCallback } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import posthog from "posthog-js";

/**
 * Signs out of WorkOS after recording the sign-out and resetting PostHog,
 * so the next person on this browser doesn't inherit the distinct id,
 * session, or super properties. Use it for every sign-out control.
 */
export function useSignOut() {
  const { signOut } = useAuth();

  return useCallback(() => {
    posthog.capture("user_signed_out");
    posthog.reset();
    return signOut();
  }, [signOut]);
}
