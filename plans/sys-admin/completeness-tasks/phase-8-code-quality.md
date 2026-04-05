# Phase 8 — Code Quality, Antipattern Resolution & Input Validation

**Goal:** Eliminate duplicated logic, consolidate shared constants, strengthen type safety at module boundaries, and add proper input validation to all user-facing mutations and actions. This phase hardens the codebase against drift, confusion, and garbage-in/garbage-out failures.

**Prerequisite:** Phase 7 complete (all HIGH and MEDIUM security/logic fixes merged).

**Acceptance Criteria:**
1. A single `getIdentityOrgId` helper exists in one shared file; all four consumer files import from it.
2. `SYSTEM_ADMIN_ORG_ID` is defined in exactly one location; both Convex and Next.js code import from it.
3. Zero `as any` or `as Id<"tenants">` casts remain in webhook ingestion code — all types are narrowed safely.
4. `createTenantInvite` rejects empty company names, invalid emails, and strings exceeding 256 characters.
5. `redeemInviteAndCreateUser` validates its inputs with the same rigor.
6. The admin invite creation form validates client-side before submission, matching backend rules.
7. Concurrent OAuth flow produces a clear, actionable error message instead of a cryptic "No code verifier found."

---

## Backend Subphases

### 8B.1 — Extract `getIdentityOrgId` to Shared Utility (`convex/lib/identity.ts`)

**Type:** Backend
**Parallelizable:** Yes — no frontend dependency.
**Finding:** Antipattern 1 from completeness report

**What:** The same `getIdentityOrgId` helper is copy-pasted across four files: `convex/tenants.ts`, `convex/onboarding/complete.ts`, `convex/calendly/oauth.ts`, and `convex/calendly/oauthQueries.ts`. Changes to JWT claim names require updating all four. Extract into a single shared module.

**Where:** Create `convex/lib/identity.ts`; modify the four consumer files.

**How:**

Create the shared module:

```typescript
// convex/lib/identity.ts

/**
 * Extract the organization ID from a Convex user identity.
 *
 * WorkOS JWTs may place the org claim under different keys depending
 * on the SDK version and token type. This function checks all known
 * variants in priority order.
 *
 * @returns The organization ID string, or undefined if no org claim is present.
 */
export function getIdentityOrgId(
  identity: Record<string, unknown>,
): string | undefined {
  return (
    (identity.organization_id as string | undefined) ??
    (identity.organizationId as string | undefined) ??
    (identity.org_id as string | undefined)
  );
}
```

Update each consumer:

```typescript
// In convex/tenants.ts, convex/onboarding/complete.ts,
// convex/calendly/oauth.ts, convex/calendly/oauthQueries.ts:

// Remove the local getIdentityOrgId function.
// Add this import:
import { getIdentityOrgId } from "./lib/identity";
// (adjust relative path per file location, e.g., "../lib/identity")
```

> **Convex guideline note:** `convex/lib/identity.ts` is a plain TypeScript module (no Convex function exports). It can be imported from any Convex file regardless of `"use node"` directive, since it only uses standard TypeScript — no Node.js APIs.

**Verification:**
- `npx convex dev` compiles without errors.
- Run the existing admin flows (create tenant, onboard, connect Calendly) — all still work because the logic is identical; only the import path changed.
- `grep -r "function getIdentityOrgId" convex/` returns exactly one result (the new shared file).

**Files touched:**
- `convex/lib/identity.ts` (create)
- `convex/tenants.ts` (modify — remove local helper, add import)
- `convex/onboarding/complete.ts` (modify — remove local helper, add import)
- `convex/calendly/oauth.ts` (modify — remove local helper, add import)
- `convex/calendly/oauthQueries.ts` (modify — remove local helper, add import)

---

### 8B.2 — Consolidate `SYSTEM_ADMIN_ORG_ID` Constant

**Type:** Backend
**Parallelizable:** Yes — independent of 8B.1.
**Finding:** Antipattern 2 from completeness report

**What:** `SYSTEM_ADMIN_ORG_ID` is hardcoded in both `convex/requireSystemAdmin.ts` and `lib/system-admin-org.ts` with a comment "keep in sync." No build-time check enforces this. If they drift, admin access breaks silently. Consolidate into a single source of truth.

**Where:**
- `convex/lib/constants.ts` (create — single source of truth)
- `convex/requireSystemAdmin.ts` (modify — import from shared)
- `lib/system-admin-org.ts` (modify — re-export from shared)

**How:**

The challenge: Convex backend code runs in a different environment than Next.js frontend code. Both need this constant. The solution is to define it in the Convex directory (the authoritative backend) and have the Next.js `lib/` file re-export it.

```typescript
// convex/lib/constants.ts

/**
 * The WorkOS organization ID for the system admin org.
 * This is the SINGLE source of truth for this value.
 * All consumers — Convex functions AND Next.js routes — must
 * import from here (directly or via re-export).
 */
export const SYSTEM_ADMIN_ORG_ID = process.env.SYSTEM_ADMIN_ORG_ID!;
```

The value is now read from the `SYSTEM_ADMIN_ORG_ID` Convex deployment environment variable. All consumers import from `convex/lib/constants.ts`.

**Verification:**
- `grep -rn "org_01"` returns no matches in source code (only plan docs with redacted placeholders).
- Next.js build succeeds (`pnpm build`).
- `npx convex dev` compiles without errors.
- Admin login still works (constant value unchanged).

**Files touched:**
- `convex/lib/constants.ts` (create)
- `convex/requireSystemAdmin.ts` (modify — import constant)
- `lib/system-admin-org.ts` (modify — re-export)

---

### 8B.3 — Replace Type Assertions in Webhook Ingestion

**Type:** Backend
**Parallelizable:** Yes — independent of 8B.1 and 8B.2.
**Finding:** Antipattern 3 from completeness report

**What:** `convex/webhooks/calendly.ts` uses `as any` and `as Id<"tenants">` casts to navigate the untyped webhook payload. Replace with runtime type narrowing that preserves type safety at the boundary.

**Where:** `convex/webhooks/calendly.ts`, specifically `getCalendlyEventUri` (lines 51–79) and the tenant ID cast (line ~147).

**How:**

Replace the `getCalendlyEventUri` function with safe runtime checks:

```typescript
// convex/webhooks/calendly.ts

/**
 * Safely extract a Calendly event URI from a webhook payload.
 * Uses runtime type narrowing instead of `as any` casts.
 */
function getCalendlyEventUri(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;

  const inner = isRecord(payload.payload) ? payload.payload : undefined;
  if (!inner) return undefined;

  // Check nested paths in priority order
  if (typeof inner.uri === "string") return inner.uri;

  const event = isRecord(inner.event) ? inner.event : undefined;
  if (event && typeof event.uri === "string") return event.uri;

  const invitee = isRecord(inner.invitee) ? inner.invitee : undefined;
  if (invitee && typeof invitee.uri === "string") return invitee.uri;

  const scheduledEvent = isRecord(inner.scheduled_event)
    ? inner.scheduled_event
    : undefined;
  if (scheduledEvent && typeof scheduledEvent.uri === "string")
    return scheduledEvent.uri;

  return undefined;
}

/** Type guard: is the value a non-null object (record)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

For the tenant ID cast, use the query result directly:

```typescript
// Before (line ~147):
// const tenantId = tenant.tenantId as Id<"tenants">;

// After:
// The calendlyQueries.ts `getTenantBySigningKey` returns a proper Id<"tenants">.
// Use the query's return type directly instead of casting.
const tenantRecord = await ctx.runQuery(
  internal.webhooks.calendlyQueries.getTenantBySigningKey,
  { signingKey: webhookSigningKey },
);
if (!tenantRecord) {
  return new Response("Unknown signing key", { status: 401 });
}
// tenantRecord._id is already Id<"tenants"> — no cast needed.
```

If the query currently returns a plain object with `tenantId` as a string, update the query to return the full document `_id` directly, which is already typed as `Id<"tenants">` by Convex.

**Verification:**
- `npx convex dev` compiles without errors.
- `grep -n "as any\|as Id" convex/webhooks/calendly.ts` returns zero matches.
- Send a test webhook → verify it is processed correctly (signature passes, event persisted).
- Send a malformed webhook (missing nested URIs) → verify the fallback URI construction works without runtime errors.

**Files touched:**
- `convex/webhooks/calendly.ts` (modify — replace casts with type narrowing)
- `convex/webhooks/calendlyQueries.ts` (modify — update return type if needed)

---

### 8B.4 — Add Input Validation on `createTenantInvite`

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Finding 2.4 from completeness report

**What:** `createTenantInvite` trims whitespace but does not validate minimum length, email format, or maximum length. Empty strings pass through. WorkOS may reject invalid emails, but the error message is cryptic.

**Where:** `convex/admin/tenants.ts`, near the top of the `createTenantInvite` handler.

**How:**

Create a shared validation module:

```typescript
// convex/lib/validation.ts

/** Minimum company name length after trimming. */
const MIN_COMPANY_NAME_LENGTH = 2;
/** Maximum company name length. */
const MAX_COMPANY_NAME_LENGTH = 256;
/** Maximum email length (RFC 5321). */
const MAX_EMAIL_LENGTH = 254;

/**
 * RFC 5322-ish email regex — catches the vast majority of invalid emails
 * without being overly strict. Rejects empty strings, missing @, etc.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCompanyName(name: string): {
  valid: boolean;
  error?: string;
} {
  const trimmed = name.trim();
  if (trimmed.length < MIN_COMPANY_NAME_LENGTH) {
    return {
      valid: false,
      error: `Company name must be at least ${MIN_COMPANY_NAME_LENGTH} characters.`,
    };
  }
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH) {
    return {
      valid: false,
      error: `Company name must not exceed ${MAX_COMPANY_NAME_LENGTH} characters.`,
    };
  }
  return { valid: true };
}

export function validateEmail(email: string): {
  valid: boolean;
  error?: string;
} {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) {
    return { valid: false, error: "Email is required." };
  }
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    return {
      valid: false,
      error: `Email must not exceed ${MAX_EMAIL_LENGTH} characters.`,
    };
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, error: "Invalid email format." };
  }
  return { valid: true };
}
```

Add validation at the top of the action handler:

```typescript
// convex/admin/tenants.ts — inside createTenantInvite handler

import { validateCompanyName, validateEmail } from "../lib/validation";

// At the top of the handler:
const companyValidation = validateCompanyName(args.companyName);
if (!companyValidation.valid) {
  throw new Error(companyValidation.error!);
}
const emailValidation = validateEmail(args.contactEmail);
if (!emailValidation.valid) {
  throw new Error(emailValidation.error!);
}

const companyName = args.companyName.trim();
const contactEmail = args.contactEmail.trim().toLowerCase();
// ... rest of handler
```

**Verification:**
- Call `createTenantInvite` with empty company name → expect error.
- Call with 300-character company name → expect error.
- Call with `"notanemail"` → expect error.
- Call with `"valid@example.com"` and `"Acme Corp"` → succeeds.

**Files touched:**
- `convex/lib/validation.ts` (create)
- `convex/admin/tenants.ts` (modify — add validation at handler entry)

---

### 8B.5 — Add Input Validation on `redeemInviteAndCreateUser`

**Type:** Backend
**Parallelizable:** Yes — can share `convex/lib/validation.ts` from 8B.4.

**What:** The onboarding redemption mutation accepts `workosUserId` and other identity fields from the caller without validation. While this is an internal call path (the auth callback provides the data), defense-in-depth requires validating that the `workosUserId` is a non-empty string and the role is a valid enum value.

**Where:** `convex/onboarding/complete.ts`

**How:**

```typescript
// convex/onboarding/complete.ts — at the top of the handler

if (!args.workosUserId || args.workosUserId.trim().length === 0) {
  throw new Error("workosUserId is required");
}

const VALID_ROLES = ["tenant_master", "tenant_admin", "closer"] as const;
if (args.role && !VALID_ROLES.includes(args.role as (typeof VALID_ROLES)[number])) {
  throw new Error(`Invalid role: ${args.role}. Must be one of: ${VALID_ROLES.join(", ")}`);
}
```

> **Convex guideline reminder:** Argument validators (`v.string()`, `v.union(v.literal(...))`) already provide type-level checks. This adds runtime semantic validation (non-empty, valid enum) as defense-in-depth.

**Verification:**
- Call `redeemInviteAndCreateUser` with empty `workosUserId` → expect error.
- Call with an invalid role string → expect error.
- Normal onboarding flow completes successfully.

**Files touched:** `convex/onboarding/complete.ts` (modify)

---

## Frontend Subphases

### 8F.1 — Client-Side Validation on Invite Creation Form

**Type:** Frontend
**Parallelizable:** After 8B.4 (backend validation must exist first so rules are consistent).

**What:** The admin invite creation dialog (`app/admin/_components/create-tenant-dialog.tsx`) currently submits directly without client-side validation. Add matching validation that prevents form submission with invalid data, showing inline error messages.

**Where:** `app/admin/_components/create-tenant-dialog.tsx`

**How:**

Import the shared validation logic (or duplicate the regex/length checks client-side for immediate feedback):

```typescript
// app/admin/_components/create-tenant-dialog.tsx

"use client";

import { useState } from "react";

// Client-side validation rules (must match convex/lib/validation.ts)
const MIN_COMPANY_NAME_LENGTH = 2;
const MAX_COMPANY_NAME_LENGTH = 256;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCompanyName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < MIN_COMPANY_NAME_LENGTH)
    return `Company name must be at least ${MIN_COMPANY_NAME_LENGTH} characters.`;
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH)
    return `Company name must not exceed ${MAX_COMPANY_NAME_LENGTH} characters.`;
  return null;
}

function validateEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) return "Email is required.";
  if (trimmed.length > MAX_EMAIL_LENGTH)
    return `Email must not exceed ${MAX_EMAIL_LENGTH} characters.`;
  if (!EMAIL_REGEX.test(trimmed)) return "Invalid email format.";
  return null;
}

// Inside the component:
const [companyError, setCompanyError] = useState<string | null>(null);
const [emailError, setEmailError] = useState<string | null>(null);

function handleSubmit() {
  const cError = validateCompanyName(companyName);
  const eError = validateEmail(contactEmail);
  setCompanyError(cError);
  setEmailError(eError);
  if (cError || eError) return;

  // Proceed with Convex action call...
}
```

Display inline errors below each input field using the project's existing UI components (likely shadcn `FormMessage` or similar).

**Verification:**
- Open admin dashboard → click "Create Tenant."
- Submit with empty fields → inline errors appear, no network request fired.
- Enter `"A"` for company → error about minimum length.
- Enter invalid email → email format error.
- Enter valid data → form submits successfully.

**Files touched:** `app/admin/_components/create-tenant-dialog.tsx` (modify)

---

### 8F.2 — Improve Concurrent OAuth Flow Error Messaging

**Type:** Frontend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Edge Case 2 from completeness report

**What:** When two browser tabs both initiate "Connect Calendly," the first tab's callback fails with "No code verifier found" because the second tab's `startOAuth` overwrote the verifier on the tenant record. The error message is cryptic. Replace with a clear, actionable message.

**Where:** `app/onboarding/connect/page.tsx` (or `app/callback/calendly/route.ts` depending on where the error surfaces)

**How:**

In the Calendly callback route, detect the specific "No code verifier found" error and map it to a user-friendly redirect:

```typescript
// app/callback/calendly/route.ts

// In the catch block where exchange errors are handled:
if (
  error instanceof Error &&
  error.message.includes("code verifier") // or whatever the exact message is
) {
  const errorUrl = new URL("/onboarding/connect", request.url);
  errorUrl.searchParams.set("error", "stale_session");
  errorUrl.searchParams.set(
    "message",
    "Your Calendly connection session expired or was started in another tab. Please try again.",
  );
  return NextResponse.redirect(errorUrl);
}
```

In the connect page, display the error:

```typescript
// app/onboarding/connect/page.tsx

const searchParams = useSearchParams();
const errorMessage = searchParams.get("message");

{errorMessage && (
  <div className="rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
    <p>{errorMessage}</p>
    <button onClick={() => handleConnectCalendly()} className="mt-2 underline">
      Try again
    </button>
  </div>
)}
```

**Verification:**
- Open two tabs on the connect Calendly page.
- Click "Connect" in both tabs.
- Complete the Calendly OAuth in the first tab → fails.
- Verify the first tab shows the friendly error with a retry button, not a cryptic error.
- Click retry → flow completes successfully.

**Files touched:**
- `app/callback/calendly/route.ts` (modify — map error to friendly redirect)
- `app/onboarding/connect/page.tsx` (modify — display friendly error)

---

## Parallelization Summary

```
8B.1 (extract getIdentityOrgId) ──────────┐
8B.2 (consolidate SYSTEM_ADMIN_ORG_ID) ───┤
8B.3 (replace type assertions) ────────────┤
8B.4 (input validation — create invite) ───┤
8B.5 (input validation — redeem invite) ───┤── all independent
8F.2 (concurrent OAuth error message) ─────┘
                                           │
8B.4 ──────────────────────────────────────→ 8F.1 (client-side validation)
```

All backend subphases (8B.1–8B.5) and 8F.2 can be built simultaneously. 8F.1 should follow 8B.4 so the validation rules are finalized before duplicating them client-side.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/identity.ts` | Create | 8B.1 |
| `convex/tenants.ts` | Modify (import shared helper) | 8B.1 |
| `convex/onboarding/complete.ts` | Modify (import shared helper + validation) | 8B.1, 8B.5 |
| `convex/calendly/oauth.ts` | Modify (import shared helper) | 8B.1 |
| `convex/calendly/oauthQueries.ts` | Modify (import shared helper) | 8B.1 |
| `convex/lib/constants.ts` | Create | 8B.2 |
| `convex/requireSystemAdmin.ts` | Modify (import constant) | 8B.2 |
| `lib/system-admin-org.ts` | Modify (re-export) | 8B.2 |
| `convex/webhooks/calendly.ts` | Modify (type narrowing) | 8B.3 |
| `convex/webhooks/calendlyQueries.ts` | Modify (return type) | 8B.3 |
| `convex/lib/validation.ts` | Create | 8B.4 |
| `convex/admin/tenants.ts` | Modify (add validation) | 8B.4 |
| `app/admin/_components/create-tenant-dialog.tsx` | Modify (client validation) | 8F.1 |
| `app/callback/calendly/route.ts` | Modify (friendly error redirect) | 8F.2 |
| `app/onboarding/connect/page.tsx` | Modify (display error) | 8F.2 |
