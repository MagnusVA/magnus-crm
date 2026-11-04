"use client";

import { useCallback } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import posthog, { postHogSettled } from "@/lib/posthog-browser";

/**
 * Signs out of WorkOS after recording the sign-out and resetting PostHog,
 * so the next person on this browser doesn't inherit the distinct id,
 * session, or super properties. Use it for every sign-out control.
 */
export function useSignOut() {
  const { signOut } = useAuth();

  return useCallback(async () => {
    posthog.capture("user_signed_out");
    posthog.reset();
    // PostHog loads after the page; a reset still queued would be lost
    // with the navigation.
    await postHogSettled();
    return signOut();
  }, [signOut]);
}
