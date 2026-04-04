import { formatDistanceToNowStrict } from "date-fns";

const ONE_MINUTE_MS = 60 * 1000;
const EXPIRING_SOON_WINDOW_MS = 30 * 60 * 1000;

export function formatCalendlyLastRefresh(
  timestamp: number,
  now: number = Date.now(),
) {
  const deltaMs = now - timestamp;

  if (deltaMs < ONE_MINUTE_MS && deltaMs > -ONE_MINUTE_MS) {
    return "Just now";
  }

  return formatDistanceToNowStrict(timestamp, {
    addSuffix: true,
  });
}

export function formatCalendlyTokenExpiry(
  timestamp: number,
  now: number = Date.now(),
) {
  const deltaMs = timestamp - now;

  if (deltaMs < ONE_MINUTE_MS && deltaMs > -ONE_MINUTE_MS) {
    return deltaMs >= 0 ? "In under a minute" : "Under a minute ago";
  }

  return formatDistanceToNowStrict(timestamp, {
    addSuffix: true,
  });
}

export function getCalendlyTokenTiming(
  tokenExpiresAt: number | null,
  now: number = Date.now(),
) {
  if (tokenExpiresAt === null) {
    return {
      isExpired: false,
      isExpiringSoon: false,
    };
  }

  const remainingMs = tokenExpiresAt - now;

  return {
    isExpired: remainingMs <= 0,
    isExpiringSoon:
      remainingMs > 0 && remainingMs <= EXPIRING_SOON_WINDOW_MS,
  };
}
