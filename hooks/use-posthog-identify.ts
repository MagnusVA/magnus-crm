"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";

interface PostHogIdentityProps {
  workosUserId: string;
  email: string;
  name: string;
  role: string;
  workosOrgId: string;
  tenantName: string;
}

/**
 * Extract the raw WorkOS user ID from the canonical storage format.
 *
 * Stored format: `https://api.workos.com/user_management/{clientId}|user_xxx`
 * Returned:      `user_xxx`
 *
 * If the ID is already raw (no `|`), returns it as-is.
 */
function extractRawWorkosUserId(canonical: string): string {
  const pipeIdx = canonical.indexOf("|");
  return pipeIdx !== -1 ? canonical.slice(pipeIdx + 1) : canonical;
}

/**
 * Identify the current user and their company group in PostHog.
 *
 * Runs once per mount. Skips if the user is already identified with the
 * same distinct_id (prevents redundant network calls on re-renders).
 *
 * Uses `workosUserId` as the PostHog `distinct_id` — it is immutable for
 * the lifetime of the user, unlike email which can change.
 *
 * IMPORTANT: Do NOT call posthog.identify() outside this hook or the
 * sign-out handler. Multiple identify calls with different distinct_ids
 * cause alias chains that are hard to untangle.
 */
export function usePostHogIdentify({
  workosUserId,
  email,
  name,
  role,
  workosOrgId,
  tenantName,
}: PostHogIdentityProps) {
  const identifiedRef = useRef<string | null>(null);

  useEffect(() => {
    const rawUserId = extractRawWorkosUserId(workosUserId);

    // Skip if already identified with this workosUserId
    if (identifiedRef.current === rawUserId) return;

    posthog.identify(rawUserId, {
      email,
      name,
      role,
      workos_user_id: rawUserId,
      workos_org_id: workosOrgId,
      tenant_name: tenantName,
    });

    posthog.group("company", workosOrgId, {
      name: tenantName,
    });

    identifiedRef.current = rawUserId;
  }, [workosUserId, email, name, role, workosOrgId, tenantName]);
}
