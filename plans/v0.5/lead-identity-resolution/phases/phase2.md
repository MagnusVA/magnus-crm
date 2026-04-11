# Phase 2 — Normalization Utilities

**Goal:** Create a pure utility module (`convex/lib/normalization.ts`) with deterministic, side-effect-free functions for normalizing email, phone, and social handles. These functions are unit-testable and consumed by Phase 3 (pipeline identity resolution).

**Prerequisite:** Phase 1 schema deployment completed (for context only; this phase has no database dependencies).

**Runs in PARALLEL with:** Phase 3 (Pipeline Integration) — 3A creates queries and mutations that depend on normalization; they can be parallelized. Phase 3B (integration into `inviteeCreated.ts`) depends on Phase 2 completion.

**Skills to invoke:**
- None — this is pure utility code with no external dependencies.

**Acceptance Criteria:**

1. `convex/lib/normalization.ts` exists with all normalization functions: `normalizeEmail()`, `normalizePhone()`, `normalizeSocialHandle()`, `normalizeIdentifier()`, `areNamesSimilar()`, `extractEmailDomain()`.
2. Social handle normalization handles all platform URL patterns (Instagram, TikTok, Twitter/X, Facebook, LinkedIn) and raw handle inputs (with/without `@` prefix).
3. Phone normalization produces E.164 format (`+{countryCode}{subscriberNumber}`) with sensible defaults for US/CA (10-digit and 11-digit inputs).
4. Email normalization is case-insensitive and rejects invalid formats.
5. Name similarity function correctly identifies matching names (exact, substring, token overlap).
6. All functions export type definitions (`IdentifierType`, `SocialPlatformType`, `NormalizationResult`).
7. No database access, no network calls, no external dependencies. Functions are pure and deterministic.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Core Normalization Functions)
    ↓
2B (Type Exports & Module Finalization)
```

**Optimal execution:**

1. Implement 2A (core functions: email, phone, social handles).
2. Add 2B (helper functions: name similarity, email domain extraction, dispatcher).
3. Verify all functions are exported and types are correct.

**Estimated time:** 1-2 hours

---

## Subphases

### 2A — Core Normalization Functions

**Type:** Backend
**Parallelizable:** No within Phase 2; depends on 2B for dispatcher completion. Can run in parallel with Phase 3A (schema queries) once this subphase exports its base functions.

**What:** Implement deterministic normalization functions for email, phone, and social handles. Each function takes a raw input string and returns a normalized value or `undefined` if the input is invalid.

**Why:** Identity resolution requires consistent normalization so that different representations of the same identifier (e.g., `@campos.coachpro`, `instagram.com/campos.coachpro`, `+1-778-955-9253`, `7789559253`) all resolve to the same canonical form for exact-match lookups in the database.

**Where:**
- `convex/lib/normalization.ts` (new)

**How:**

**Step 1: Create the file and add type definitions**

```typescript
// Path: convex/lib/normalization.ts

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
export type NormalizationResult = {
  normalized: string;
  type: IdentifierType;
} | undefined;
```

**Step 2: Implement email normalization**

```typescript
// Path: convex/lib/normalization.ts

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
```

**Step 3: Implement phone number normalization**

```typescript
// Path: convex/lib/normalization.ts

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
```

**Step 4: Implement social handle normalization**

```typescript
// Path: convex/lib/normalization.ts

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
```

**Key implementation notes:**

- Social handle normalization tries URL patterns first (more specific), then falls back to raw handle parsing. This avoids false rejects when a user pastes a full profile URL.
- Email validation is strict but not exhaustive — it checks for basic structure (`local@domain.tld`), not RFC 5322 compliance. This avoids false negatives while rejecting obviously malformed emails.
- Phone normalization is best-effort. The E.164 format is `+{countryCode}{subscriberNumber}`. For 10 and 11-digit inputs, we assume North America. For other lengths, we prepend `+` and hope the raw number is valid.
- The `PLATFORM_URL_PATTERNS` can be extended in future if new social platforms are added to `IdentifierType`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/normalization.ts` | Create | Core normalization functions (email, phone, social handle) |

---

### 2B — Helper Functions & Module Finalization

**Type:** Backend
**Parallelizable:** Depends on 2A. This is the final step of Phase 2.

**What:** Add name similarity function (for fuzzy duplicate detection) and the identifier normalization dispatcher function that routes to the appropriate normalizer based on type.

**Why:** Name similarity is needed by Phase 3 to detect potential duplicates. The dispatcher provides a single entry point for normalizing any identifier type, reducing code duplication in the pipeline.

**How:**

**Step 1: Add name similarity function**

```typescript
// Path: convex/lib/normalization.ts (appended to existing file)

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
```

**Step 2: Add the identifier normalization dispatcher**

```typescript
// Path: convex/lib/normalization.ts (appended to existing file)

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
```

**Step 3: Verify exports and type safety**

Ensure the file exports all public functions and types:

```typescript
// Path: convex/lib/normalization.ts (at the top, exports are automatic)

// Public exports (all are at module level):
// - normalizeEmail
// - extractEmailDomain
// - normalizePhone
// - normalizeSocialHandle
// - areNamesSimilar
// - normalizeIdentifier
// - IdentifierType (type)
// - SocialPlatformType (type)
// - NormalizationResult (type)

// Run type check:
// pnpm tsc --noEmit
```

**Key implementation notes:**

- The `areNamesSimilar` function is intentionally conservative. It will miss some duplicates (e.g., "John" vs "Jane" from the same email domain), but avoids false positives that could incorrectly suggest merging unrelated people.
- The dispatcher `normalizeIdentifier` returns `{ normalized, type }` or `undefined`. This is useful for pipeline code that needs to know both the normalized value and its type.
- No logging or side effects in any normalization function. All logging happens at the call site (Phase 3).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/normalization.ts` | Modify | Add name similarity and dispatcher functions |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/normalization.ts` | Create | 2A, 2B |

---

## Notes for Implementer

- **No external dependencies:** This module has zero imports beyond standard TypeScript types. No `convex` imports, no `npm` packages. It's pure application logic.
- **Deterministic & testable:** Every function is deterministic (same input always produces same output) and has no side effects. These functions are ideal for unit testing, though tests are deferred per user request.
- **Platform support:** Social handle patterns support Instagram, TikTok, Twitter/X (both old and new domains), Facebook, and LinkedIn. The `other_social` type is a catch-all for future platforms.
- **Phone handling:** The default country code is "+1" (North America). This is configurable via the `DEFAULT_COUNTRY_CODE` constant if internationalization is needed in the future.
- **Email handling:** Does not apply aggressive normalization (no Gmail `+tag` stripping, no dot removal). This avoids false-positive merges of distinct email addresses.
- **Next phase:** After Phase 2 completes, Phase 3 can consume these functions. Phase 3A (queries) can start in parallel with Phase 2B completion.
