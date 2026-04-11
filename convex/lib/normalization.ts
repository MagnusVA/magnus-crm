/**
 * Identifier type union -- matches the leadIdentifiers.type schema.
 */
export type IdentifierType =
  | "email"
  | "phone"
  | "instagram"
  | "tiktok"
  | "twitter"
  | "facebook"
  | "linkedin"
  | "other_social";

/**
 * Social platform type -- subset of IdentifierType for social handles.
 */
export type SocialPlatformType =
  | "instagram"
  | "tiktok"
  | "twitter"
  | "facebook"
  | "linkedin"
  | "other_social";

/**
 * Result of normalizing an identifier value.
 */
export type NormalizationResult =
  | {
      normalized: string;
      type: IdentifierType;
    }
  | undefined;

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Canonicalize an email address for identity resolution.
 *
 * - Lowercase the entire address
 * - Trim whitespace
 *
 * Does NOT strip Gmail-style +tags or dots because those are distinct
 * addresses on most providers. Overly aggressive canonicalization
 * would cause false positive merges.
 *
 * @returns Normalized email (lowercase, trimmed), or undefined if invalid.
 */
export function normalizeEmail(rawValue: string): string | undefined {
  const trimmed = rawValue.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  // Basic format check: must have @ with non-empty content on both sides
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return undefined;

  return trimmed;
}

/**
 * Extract the domain from an email address.
 * Used for weak duplicate detection (same domain + similar name).
 *
 * @returns The domain part of the email (after @), lowercase, or undefined.
 */
export function extractEmailDomain(email: string): string | undefined {
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 0) return undefined;
  return email.slice(atIndex + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Strip all non-digit characters except a leading +.
 */
function stripPhoneFormatting(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) {
    return "+" + trimmed.slice(1).replace(/\D/g, "");
  }
  return trimmed.replace(/\D/g, "");
}

/**
 * Default country code applied when the phone number has no country code prefix.
 * US/Canada (+1) is the default for this CRM's primary market.
 */
const DEFAULT_COUNTRY_CODE = "1";

/**
 * Normalize a phone number to E.164 format.
 *
 * Rules:
 * - If the input starts with "+", it already has a country code -- strip formatting only.
 * - If the input is 10 digits, assume US/CA and prepend "+1".
 * - If the input is 11 digits starting with "1", assume US/CA and prepend "+".
 * - Otherwise, prepend "+" and hope for the best (best-effort).
 *
 * Examples:
 *   "+1 778-955-9253"  --> "+17789559253"
 *   "(778) 955-9253"   --> "+17789559253"
 *   "7789559253"       --> "+17789559253"
 *   "17789559253"      --> "+17789559253"
 *
 * @returns E.164 formatted phone string, or undefined if invalid.
 */
export function normalizePhone(rawValue: string): string | undefined {
  const stripped = stripPhoneFormatting(rawValue);
  if (stripped.length === 0) return undefined;

  // Already has country code prefix
  if (stripped.startsWith("+")) {
    // Minimum viable: + followed by at least 7 digits
    return stripped.length >= 8 ? stripped : undefined;
  }

  // 10 digits: assume US/CA, prepend +1
  if (stripped.length === 10) {
    return `+${DEFAULT_COUNTRY_CODE}${stripped}`;
  }

  // 11 digits starting with 1: assume US/CA with leading 1
  if (stripped.length === 11 && stripped.startsWith("1")) {
    return `+${stripped}`;
  }

  // Fallback: prepend + if we have enough digits for a plausible number
  if (stripped.length >= 7 && stripped.length <= 15) {
    return `+${stripped}`;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Social handles
// ---------------------------------------------------------------------------

/**
 * URL patterns per platform for extracting usernames from profile URLs.
 * Each pattern captures the username as group 1.
 */
const PLATFORM_URL_PATTERNS: Record<SocialPlatformType, RegExp[]> = {
  instagram: [
    /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)\/?$/,
  ],
  tiktok: [
    /^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@?([a-zA-Z0-9_.]+)\/?$/,
  ],
  twitter: [
    /^(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/?$/,
  ],
  facebook: [
    /^(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9_.]+)\/?$/,
  ],
  linkedin: [
    /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)\/?$/,
  ],
  other_social: [],
};

/**
 * Normalize a social handle for a given platform.
 *
 * Handles these input patterns:
 * - Raw handle: "campos.coachpro" or "@campos.coachpro"
 * - Profile URL: "instagram.com/campos.coachpro" or "https://www.instagram.com/campos.coachpro/"
 *
 * @returns Normalized handle (lowercase, no @, no URL components), or undefined if invalid.
 */
export function normalizeSocialHandle(
  rawValue: string,
  platform: SocialPlatformType,
): string | undefined {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return undefined;

  // Try URL patterns first (more specific)
  const patterns = PLATFORM_URL_PATTERNS[platform];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }

  // Fall back to raw handle: strip leading @, lowercase
  let handle = trimmed;
  if (handle.startsWith("@")) {
    handle = handle.slice(1);
  }

  // Reject if it looks like a URL we could not parse
  if (handle.includes("/") || handle.includes("://")) {
    return undefined;
  }

  // Reject empty after stripping
  handle = handle.toLowerCase().trim();
  return handle.length > 0 ? handle : undefined;
}

// ---------------------------------------------------------------------------
// Name similarity
// ---------------------------------------------------------------------------

/**
 * Simple name similarity check for fuzzy duplicate detection.
 *
 * Compares two names after normalization (lowercase, collapse whitespace).
 * Returns true if:
 * - Names are identical after normalization, OR
 * - One name is a substring of the other (handles "John" vs "John Smith"), OR
 * - First/last name tokens overlap (handles "John Smith" vs "Smith, John")
 *
 * This is intentionally conservative -- it will miss some true duplicates
 * but avoids false positives. Feature E uses this ONLY for "suggested"
 * confidence flags, never for auto-merge.
 *
 * @returns true if names are similar, false otherwise.
 */
export function areNamesSimilar(
  name1: string | undefined,
  name2: string | undefined,
): boolean {
  if (!name1 || !name2) return false;

  const normalize = (n: string) =>
    n.trim().toLowerCase().replace(/\s+/g, " ");

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  // Exact match after normalization
  if (n1 === n2) return true;

  // One is a substring of the other (handles partial name matches)
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Token overlap: if both names share at least one non-trivial token
  const tokens1 = new Set(n1.split(" ").filter((t) => t.length > 1));
  const tokens2 = new Set(n2.split(" ").filter((t) => t.length > 1));
  for (const token of tokens1) {
    if (tokens2.has(token)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Normalize an identifier value based on its type.
 * Dispatches to the appropriate platform-specific normalizer.
 *
 * @param rawValue The raw input string to normalize.
 * @param type The identifier type (email, phone, instagram, etc.).
 * @returns Object with normalized value and type, or undefined if invalid.
 */
export function normalizeIdentifier(
  rawValue: string,
  type: IdentifierType,
): NormalizationResult {
  switch (type) {
    case "email": {
      const normalized = normalizeEmail(rawValue);
      return normalized ? { normalized, type } : undefined;
    }
    case "phone": {
      const normalized = normalizePhone(rawValue);
      return normalized ? { normalized, type } : undefined;
    }
    case "instagram":
    case "tiktok":
    case "twitter":
    case "facebook":
    case "linkedin":
    case "other_social": {
      const normalized = normalizeSocialHandle(rawValue, type);
      return normalized ? { normalized, type } : undefined;
    }
    default:
      return undefined;
  }
}
