import "server-only";
import { cookies } from "next/headers";
import { getPostHogClient } from "@/lib/posthog-server";

/**
 * Extract the PostHog distinct_id from the browser cookie set by posthog-js.
 *
 * PostHog stores session state in a cookie named `ph_{apiKey}_posthog`
 * whose value is a JSON object containing `distinct_id`.
 */
async function getPostHogDistinctId(): Promise<string | undefined> {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!token) return undefined;

  const cookieStore = await cookies();
  const phCookie = cookieStore.get(`ph_${token}_posthog`);
  if (!phCookie?.value) return undefined;

  try {
    const parsed = JSON.parse(decodeURIComponent(phCookie.value)) as {
      distinct_id?: unknown;
    };
    return typeof parsed.distinct_id === "string"
      ? parsed.distinct_id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture a server-side PostHog event attributed to the current user.
 *
 * Reads the PostHog distinct_id from the cookie set by posthog-js.
 * Falls back to a provided distinctId if the cookie is not available.
 *
 * Usage in server actions / route handlers:
 *
 * ```ts
 * await captureServerEvent("form_submitted", { formId: "abc" });
 * ```
 */
export async function captureServerEvent(
  event: string,
  properties?: Record<string, unknown>,
  fallbackDistinctId?: string,
) {
  const cookieDistinctId = await getPostHogDistinctId();
  const distinctId = cookieDistinctId ?? fallbackDistinctId ?? "system:server";

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      $source: "server",
    },
  });
}
