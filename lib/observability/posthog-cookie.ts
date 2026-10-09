/**
 * Reads the person and session from the `ph_<token>_posthog` cookie that
 * posthog-js sets, so server-side errors link to the same person and
 * session replay as the browser.
 */
export function readPostHogCookie(
  cookieHeader: string | undefined | null,
  projectToken: string | undefined,
): { distinctId?: string; sessionId?: string } {
  if (!cookieHeader || !projectToken) return {};
  const name = `ph_${projectToken}_posthog=`;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name))
    ?.slice(name.length);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as {
      distinct_id?: unknown;
      $sesid?: unknown;
    };
    const sessionId =
      Array.isArray(parsed.$sesid) && typeof parsed.$sesid[1] === "string"
        ? parsed.$sesid[1]
        : undefined;
    return {
      distinctId: typeof parsed.distinct_id === "string" ? parsed.distinct_id : undefined,
      sessionId,
    };
  } catch {
    return {};
  }
}
