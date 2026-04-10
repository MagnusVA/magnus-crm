/**
 * Meeting location normalization from Calendly webhook payloads.
 *
 * Handles both Zoom-native locations (type: "zoom", join_url) and
 * custom locations (type: "custom", location) to extract a usable
 * meeting join URL.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTrimmedString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Already has a scheme
  if (value.startsWith("http://") || value.startsWith("https://"))
    return value;
  // Conservative normalization: only prefix https:// for bare domain/path
  // - No whitespace (prevents injection of arbitrary text)
  // - Contains at least one dot (likely a domain)
  if (value.includes(" ") || !value.includes(".")) return undefined;
  return `https://${value}`;
}

export interface MeetingLocation {
  meetingJoinUrl?: string;
  meetingLocationType?: string;
  zoomJoinUrl?: string;
}

/**
 * Extract meeting location from Calendly scheduled_event.location payload.
 *
 * Returns normalized URLs ready for storage:
 * - meetingJoinUrl: generic online meeting URL (the primary field for new code)
 * - meetingLocationType: the raw/normalized Calendly location.type (for observability)
 * - zoomJoinUrl: legacy field, only set for genuine Zoom payloads (for compatibility)
 */
export function extractMeetingLocation(location: unknown): MeetingLocation {
  if (!isRecord(location)) return {};

  const type = getTrimmedString(location, "type");
  const joinUrl = normalizeHttpUrl(getTrimmedString(location, "join_url"));
  const customLocation = normalizeHttpUrl(getTrimmedString(location, "location"));

  // Zoom-native: type="zoom" with join_url
  if (type === "zoom" && joinUrl) {
    return {
      meetingJoinUrl: joinUrl,
      meetingLocationType: "zoom",
      zoomJoinUrl: joinUrl,
    };
  }

  // Custom location: type="custom" with a usable URL in location field
  if (customLocation) {
    return {
      meetingJoinUrl: customLocation,
      meetingLocationType: type ?? "custom",
    };
  }

  // No usable URL, but type is known (physical, phone, etc.)
  return {
    meetingLocationType: type,
  };
}

/**
 * Read helper: return the best available meeting join URL.
 *
 * Prefers the generic meetingJoinUrl, falls back to the legacy zoomJoinUrl
 * during the migration window.
 */
export function getStoredMeetingJoinUrl(meeting: {
  meetingJoinUrl?: string;
  zoomJoinUrl?: string;
}): string | undefined {
  return meeting.meetingJoinUrl ?? meeting.zoomJoinUrl;
}
