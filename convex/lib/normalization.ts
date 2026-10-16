import type { SocialPlatform } from "./socialPlatform";

export type SocialPlatformType = SocialPlatform;

/**
 * Identifier type union -- matches the leadIdentifiers.type schema.
 */
export type IdentifierType = "email" | "phone" | SocialPlatformType;

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

/** Placeholder addresses typed into booking forms in production. */
const PLACEHOLDER_EMAILS = new Set([
  "email@gmail.com",
  "email@yahoo.com",
  "email@icloud.com",
  "thisisnotanemail@notanemail.com",
]);
const PLACEHOLDER_EMAIL_LOCAL_PARTS = new Set(["email"]);
// example.com/.org/.net are left out: the test suite books with them as real
// addresses.
const PLACEHOLDER_EMAIL_DOMAINS = new Set(["notanemail.com"]);

/**
 * True for an address that people type when they don't want to give one,
 * such as `email@gmail.com`. Several people share each of these, so a
 * placeholder must never decide identity: identity resolution skips it, and
 * it never becomes a lead's email or an email identifier. It stays on the
 * booking, because Calendly requires an email.
 *
 * @param normalizedEmail Output of `normalizeEmail`.
 */
export function isPlaceholderEmail(normalizedEmail: string): boolean {
  if (PLACEHOLDER_EMAILS.has(normalizedEmail)) return true;
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex < 0) return false;
  return (
    PLACEHOLDER_EMAIL_LOCAL_PARTS.has(normalizedEmail.slice(0, atIndex)) ||
    PLACEHOLDER_EMAIL_DOMAINS.has(normalizedEmail.slice(atIndex + 1))
  );
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
 * Fake numbers seen in production, as digits. Each one merged several
 * bookers into one lead (docs/plans/polluted-lead-split.md). Checked against
 * both the input digits and the normalized number's digits.
 */
const PLACEHOLDER_PHONE_DIGITS = new Set([
  "1234567890",
  "12345678910",
  "11234567890",
  "0123456789",
  "0987654321",
  "12342342342",
  "12345678901",
  "12123456789",
  "12345678945",
  // Outside North America the pattern rule below doesn't apply, so these are
  // listed: each was typed by several bookers (Tier D, polluted-lead split).
  "61423567890",
  "61234567891",
  "912345678990",
]);

/**
 * Pattern rule for fake North American numbers (+1 and 10 digits). The
 * 10-digit national number is fake when it contains an ascending or
 * descending run of SEQUENTIAL_RUN_MIN digits (2345678, 9876543), or when its
 * first REPEATED_GROUP_SPAN digits repeat one 3-digit group (234-234-234x).
 * Other country codes are exempt: the same patterns occur in real
 * Indonesian, Kenyan, and Swedish numbers.
 */
const SEQUENTIAL_RUN_MIN = 7;
const REPEATED_GROUP_LENGTH = 3;
const REPEATED_GROUP_SPAN = 9;

function hasSequentialRun(digits: string, minLength: number): boolean {
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < digits.length; i++) {
    const step = Number(digits[i]) - Number(digits[i - 1]);
    ascending = step === 1 ? ascending + 1 : 1;
    descending = step === -1 ? descending + 1 : 1;
    if (ascending >= minLength || descending >= minLength) return true;
  }
  return false;
}

function isFakeNorthAmericanNumber(e164: string): boolean {
  const national = /^\+1(\d{10})$/.exec(e164)?.[1];
  if (!national) return false;
  const group = national.slice(0, REPEATED_GROUP_LENGTH);
  return (
    hasSequentialRun(national, SEQUENTIAL_RUN_MIN) ||
    national.slice(0, REPEATED_GROUP_SPAN) ===
      group.repeat(REPEATED_GROUP_SPAN / REPEATED_GROUP_LENGTH)
  );
}

/**
 * Normalize a phone number to E.164 format.
 *
 * Rules:
 * - If the input starts with "+", it already has a country code -- strip formatting only.
 * - If the input is 10 digits, assume US/CA and prepend "+1".
 * - If the input is 11 digits starting with "1", assume US/CA and prepend "+".
 * - Otherwise, prepend "+" and hope for the best (best-effort).
 * - Placeholder numbers (see above) are rejected, so they never become
 *   shared identity keys.
 *
 * Examples:
 *   "+1 778-955-9253"  --> "+17789559253"
 *   "(778) 955-9253"   --> "+17789559253"
 *   "7789559253"       --> "+17789559253"
 *   "17789559253"      --> "+17789559253"
 *   "+1 234-234-2342"  --> undefined
 *
 * @returns E.164 formatted phone string, or undefined if invalid.
 */
export function normalizePhone(rawValue: string): string | undefined {
  const stripped = stripPhoneFormatting(rawValue);
  const digits = stripped.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  // Common placeholders must never become shared identity keys.
  if (isPlaceholderPhone(rawValue)) return undefined;
  return formatE164(stripped);
}

/**
 * True for a number `normalizePhone` rejects as a placeholder, as opposed to
 * one it can't read. Cleanup uses this to clear only fake values.
 */
export function isPlaceholderPhone(rawValue: string): boolean {
  const stripped = stripPhoneFormatting(rawValue);
  const digits = stripped.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  if (/^(\d)\1+$/.test(digits) || PLACEHOLDER_PHONE_DIGITS.has(digits)) return true;
  const normalized = formatE164(stripped);
  return (
    normalized !== undefined &&
    (PLACEHOLDER_PHONE_DIGITS.has(normalized.slice(1)) ||
      isFakeNorthAmericanNumber(normalized))
  );
}

function formatE164(stripped: string): string | undefined {
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
    /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)\/?(?:[?#].*)?$/,
  ],
  tiktok: [
    /^(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@?([a-zA-Z0-9_.]+)\/?(?:[?#].*)?$/,
  ],
  twitter: [
    /^(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/?(?:[?#].*)?$/,
  ],
  facebook: [
    /^(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9_.]+)\/?(?:[?#].*)?$/,
  ],
  linkedin: [
    /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)\/?(?:[?#].*)?$/,
  ],
  other_social: [],
};

/**
 * Answers people type when they have no handle. A handle also needs at least
 * MIN_HANDLE_ALPHANUMERICS letters or digits, which rejects "g" and "-".
 */
const PLACEHOLDER_SOCIAL_HANDLES = new Set([
  "na",
  "n/a",
  "none",
  "null",
  "nil",
  "no",
  "-",
  "...",
  ".",
  "test",
]);
const MIN_HANDLE_ALPHANUMERICS = 2;

function rejectPlaceholderHandle(handle: string): string | undefined {
  return isPlaceholderHandle(handle) ? undefined : handle;
}

/**
 * True for a handle `normalizeSocialHandle` rejects as a placeholder answer.
 *
 * @param handle A normalized handle: lowercase, without a leading @.
 */
export function isPlaceholderHandle(handle: string): boolean {
  if (PLACEHOLDER_SOCIAL_HANDLES.has(handle)) return true;
  const alphanumerics = handle.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return alphanumerics < MIN_HANDLE_ALPHANUMERICS;
}

/**
 * Normalize a social handle for a given platform.
 *
 * Handles these input patterns:
 * - Raw handle: "campos.coachpro" or "@campos.coachpro"
 * - Profile URL: "instagram.com/campos.coachpro" or "https://www.instagram.com/campos.coachpro/"
 *
 * Placeholder answers ("na", "none", a single letter) are rejected so they
 * never become shared identity keys.
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
      return rejectPlaceholderHandle(match[1].toLowerCase());
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

  // Reject empty or placeholder after stripping
  return rejectPlaceholderHandle(handle.toLowerCase().trim());
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
