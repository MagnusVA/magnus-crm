const HOST_PATTERN = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;

/**
 * The host the browser asked for, lowercased, or `invalid` when the header
 * isn't a plain host. Safe to send as an event property.
 */
export function requestHost(request: Request): string {
  const raw =
    request.headers.get("x-forwarded-host")?.split(",")[0] ??
    request.headers.get("host") ??
    new URL(request.url).host;
  const host = raw.trim().toLowerCase();
  return HOST_PATTERN.test(host) ? host : "invalid";
}
