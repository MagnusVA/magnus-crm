# Phase 3 — Pipeline Identity Resolution

**Goal:** Replace the current email-only lead lookup in `convex/pipeline/inviteeCreated.ts` with a multi-identifier resolution chain (email → social handle → phone → new lead). Extract social handles from Calendly form data using Feature F's `customFieldMappings`, create `leadIdentifier` records for provenance tracking, and detect potential duplicates via fuzzy matching. After this phase, every `invitee.created` webhook populates the `leadIdentifiers` table and correctly resolves returning leads across identifiers.

**Prerequisite:** Phase 1 (schema deployed — `leadIdentifiers` table, optional fields on `leads` and `opportunities`) and Phase 2 (normalization utilities in `convex/lib/normalization.ts`).

**Runs in PARALLEL with:** Nothing — this phase modifies the core pipeline handler and depends on both Phase 1 and Phase 2.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).
> Start as early as possible after Phase 2 completes.

**Skills to invoke:**
- `convex-performance-audit` — after implementation, audit the identity resolution hot path to ensure `leadIdentifiers` index lookups are performant and stay within Convex function limits (bytes read, execution time per webhook)
- `simplify` — review the modified `inviteeCreated.ts` for code quality, reuse, and efficiency after all helper functions are integrated

**Acceptance Criteria:**

1. When an `invitee.created` webhook arrives for an email that already exists in `leadIdentifiers` or in the legacy `leads.email` index, the pipeline resolves to the existing lead (auto-merge) instead of creating a duplicate.
2. When an `invitee.created` webhook arrives with a social handle (via `customFieldMappings`) that matches an existing `leadIdentifier` record, the pipeline resolves to the existing lead.
3. When an `invitee.created` webhook arrives with a phone number matching an existing `leadIdentifier` record, the pipeline resolves to the existing lead.
4. When no identifier match is found, a new lead is created with `status: "active"`.
5. After every booking, `leadIdentifier` records are created for each available identifier (email always, phone and social handle when present). Duplicate identifier records are not created on webhook retries (idempotent).
6. When a fuzzy match is detected (same non-public email domain + similar name), the new opportunity's `potentialDuplicateLeadId` is set to the suspected duplicate's lead ID.
7. The `socialHandles` denormalized array on the lead is updated when a new social handle is extracted.
8. Existing pipeline behavior (closer assignment, event type config, follow-up detection, meeting creation, UTM extraction, Feature F auto-discovery) continues to work unchanged.
9. Structured logs with `[Pipeline:Identity]` tag are emitted at each decision point (match found, new lead, fuzzy match, identifier created).
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Helper Functions) ─────────────────────────────┐
                                                    ├── 3C (Pipeline Integration)
3B (Identity Resolution Core) ─────────────────────┘
                                                    │
                                                    ↓
                                                3D (Lead Identifier Creation & Denormalization)
```

**Optimal execution:**

1. Start 3A (helper functions: custom field extraction, upsert, denormalization) and 3B (identity resolution chain: `resolveLeadIdentity`, `followMergeChain`, `detectPotentialDuplicate`) in parallel — they are independent functions in the same file.
2. Once 3A and 3B are complete → start 3C (wire everything into the `process` handler, replacing the existing lead lookup block).
3. Once 3C is complete → start 3D (add `createLeadIdentifiers` call after meeting creation, verify end-to-end).

**Estimated time:** 3-5 hours

---

## Subphases

### 3A — Helper Functions (Extraction, Upsert, Denormalization)

**Type:** Backend
**Parallelizable:** Yes — independent of 3B. Both write new functions in `inviteeCreated.ts` without overlap.

**What:** Three helper functions in `convex/pipeline/inviteeCreated.ts`:
1. `extractIdentifiersFromCustomFields()` — reads `customFieldMappings` from event type config to extract social handle and phone override from booking form data.
2. `upsertLeadIdentifier()` — idempotently inserts a `leadIdentifier` record (skips if identical record exists).
3. `updateLeadSocialHandles()` — updates the denormalized `socialHandles` array on the lead.

**Why:** These functions are consumed by the pipeline integration (3C) and the identifier creation step (3D). Separating them as helpers keeps the main handler readable and makes each function independently testable.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Add imports for normalization functions**

Add these imports at the top of the file, alongside existing imports:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// Add to existing imports:
import {
  normalizeEmail,
  normalizeSocialHandle,
  normalizePhone,
  areNamesSimilar,
  extractEmailDomain,
} from "../lib/normalization";
import type { SocialPlatformType } from "../lib/normalization";
```

> **Note:** `Doc` and `Id` are already imported from `"../_generated/dataModel"` and `MutationCtx` is already imported from `"../_generated/server"` in the existing file. Do not add duplicate imports.

**Step 2: Add type definitions**

Add after the existing imports and before `isRecord`:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Result of extracting identifiers from custom form fields.
 */
type ExtractedIdentifiers = {
  socialHandle?: {
    rawValue: string;
    platform: SocialPlatformType;
  };
  phoneOverride?: string;
};
```

**Step 3: Add `extractIdentifiersFromCustomFields` function**

Add this function after the existing `mergeCustomFields` function (around line 63):

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Extract social handle and phone override from custom form fields
 * using the event type's customFieldMappings configuration (Feature F).
 *
 * Returns undefined values if no mapping is configured or no matching
 * answer is found in the booking's custom fields.
 */
function extractIdentifiersFromCustomFields(
  customFields: Record<string, string> | undefined,
  config: Doc<"eventTypeConfigs"> | null,
): ExtractedIdentifiers {
  const result: ExtractedIdentifiers = {};

  if (!customFields || !config?.customFieldMappings) {
    return result;
  }

  const mappings = config.customFieldMappings;

  // Social handle extraction
  if (mappings.socialHandleField && mappings.socialHandleType) {
    const rawValue = customFields[mappings.socialHandleField];
    if (rawValue && rawValue.trim().length > 0) {
      result.socialHandle = {
        rawValue: rawValue.trim(),
        platform: mappings.socialHandleType,
      };
      console.log(
        `[Pipeline:Identity] Social handle extracted from custom field | field="${mappings.socialHandleField}" platform=${mappings.socialHandleType} rawValue="${rawValue.trim()}"`,
      );
    }
  }

  // Phone override extraction
  if (mappings.phoneField) {
    const rawValue = customFields[mappings.phoneField];
    if (rawValue && rawValue.trim().length > 0) {
      result.phoneOverride = rawValue.trim();
      console.log(
        `[Pipeline:Identity] Phone override extracted from custom field | field="${mappings.phoneField}" rawValue="${rawValue.trim()}"`,
      );
    }
  }

  return result;
}
```

**Step 4: Add `upsertLeadIdentifier` function**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Insert a leadIdentifier record if one with the same (tenantId, type, value)
 * does not already exist. This makes the operation idempotent for webhook retries.
 *
 * If an identical record exists (even for a different lead), it is skipped.
 * The identity resolution chain already resolved to the correct lead in a prior step.
 */
async function upsertLeadIdentifier(
  ctx: MutationCtx,
  record: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    type: "email" | "phone" | "instagram" | "tiktok" | "twitter" | "facebook" | "linkedin" | "other_social";
    value: string;
    rawValue: string;
    source: "calendly_booking" | "manual_entry" | "merge";
    sourceMeetingId?: Id<"meetings">;
    confidence: "verified" | "inferred" | "suggested";
    createdAt: number;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_tenantId_and_type_and_value", (q) =>
      q
        .eq("tenantId", record.tenantId)
        .eq("type", record.type)
        .eq("value", record.value),
    )
    .first();

  if (existing) {
    console.log(
      `[Pipeline:Identity] Identifier already exists | type=${record.type} value=${record.value} existingLeadId=${existing.leadId} requestedLeadId=${record.leadId}`,
    );
    return;
  }

  await ctx.db.insert("leadIdentifiers", record);
  console.log(
    `[Pipeline:Identity] Identifier created | type=${record.type} value=${record.value} leadId=${record.leadId} confidence=${record.confidence}`,
  );
}
```

**Step 5: Add `updateLeadSocialHandles` function**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Update the denormalized socialHandles array on the leads table.
 * Adds the new handle if not already present. Checks for duplicates
 * by (type, handle) pair to avoid growing the array unnecessarily.
 */
async function updateLeadSocialHandles(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  platform: string,
  normalizedHandle: string,
): Promise<void> {
  const lead = await ctx.db.get(leadId);
  if (!lead) return;

  const existing = lead.socialHandles ?? [];
  const alreadyExists = existing.some(
    (h) => h.type === platform && h.handle === normalizedHandle,
  );

  if (!alreadyExists) {
    await ctx.db.patch(leadId, {
      socialHandles: [...existing, { type: platform, handle: normalizedHandle }],
    });
  }
}
```

**Key implementation notes:**
- `extractIdentifiersFromCustomFields` reads from `config.customFieldMappings` which was deployed as part of Feature F. The function is a pure data extractor — no database access.
- `upsertLeadIdentifier` uses the `by_tenantId_and_type_and_value` index for the existence check. This is an exact-match lookup, not a scan. The record parameter is explicitly typed with union literals matching the schema (not `string`) for type safety.
- `updateLeadSocialHandles` reads the lead, checks for duplicates, and patches. The array is naturally bounded by the number of distinct social platform types (8 max).
- All three functions are file-private (not exported). They are only used within the `inviteeCreated.ts` handler.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add normalization imports, type definitions, and 3 helper functions |

---

### 3B — Identity Resolution Core (Resolve, Merge Chain, Fuzzy Match)

**Type:** Backend
**Parallelizable:** Yes — independent of 3A. Both write new functions in `inviteeCreated.ts` without overlap.

**What:** Three core functions for multi-identifier identity resolution:
1. `resolveLeadIdentity()` — the main resolution chain (email → social → phone → new lead).
2. `followMergeChain()` — follows `mergedIntoLeadId` pointers to find the active lead (future-proofing for Feature C merges).
3. `detectPotentialDuplicate()` — fuzzy match heuristic (same email domain + similar name) that flags suspected duplicates.

**Why:** These functions implement the core identity resolution logic. `resolveLeadIdentity` replaces the current simple email lookup. `followMergeChain` ensures that merged leads (Feature C, future) are correctly followed. `detectPotentialDuplicate` surfaces near-matches for human review without auto-merging.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Add `IdentityResolutionResult` type**

Add alongside the `ExtractedIdentifiers` type from 3A:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Result of multi-identifier identity resolution.
 * Describes how a lead was resolved and whether a potential duplicate was detected.
 */
type IdentityResolutionResult = {
  lead: Doc<"leads">;
  isNewLead: boolean;
  resolvedVia: "email" | "social_handle" | "phone" | "new";
  potentialDuplicateLeadId?: Id<"leads">;
};
```

**Step 2: Implement `followMergeChain` function**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Follow the merge chain to find the active lead.
 * Returns undefined if the chain leads to a non-existent or non-active lead.
 *
 * Max depth of 5 to prevent infinite loops from data corruption.
 * Feature C (Lead Manager) creates merge chains; this function ensures
 * the pipeline follows them correctly from day one.
 */
async function followMergeChain(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<Doc<"leads"> | undefined> {
  let current = lead;
  let depth = 0;
  const MAX_DEPTH = 5;

  while (
    current.status === "merged" &&
    current.mergedIntoLeadId &&
    depth < MAX_DEPTH
  ) {
    const next = await ctx.db.get(current.mergedIntoLeadId);
    if (!next) {
      console.error(
        `[Pipeline:Identity] Broken merge chain at depth=${depth} | leadId=${current._id} mergedIntoLeadId=${current.mergedIntoLeadId}`,
      );
      return undefined;
    }
    current = next;
    depth++;
  }

  if (depth >= MAX_DEPTH) {
    console.error(
      `[Pipeline:Identity] Merge chain too deep (>${MAX_DEPTH}) | startLeadId=${lead._id}`,
    );
    return undefined;
  }

  // Skip if the final lead is still in "merged" state (broken chain)
  if (current.status === "merged") {
    return undefined;
  }

  return current;
}
```

**Step 3: Implement `detectPotentialDuplicate` function**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Detect potential duplicate leads using fuzzy matching.
 *
 * Checks: same non-public email domain + similar name.
 * Returns the lead ID of the suspected duplicate, or undefined.
 *
 * This is a best-effort heuristic — only exact identifier matches trigger
 * auto-merge. Fuzzy matches flag for human review only.
 *
 * Bounded to 50 most recent leads to keep the hot path fast.
 */
async function detectPotentialDuplicate(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  newLeadName: string | undefined,
  newLeadEmail: string,
  newLeadId: Id<"leads">,
): Promise<Id<"leads"> | undefined> {
  if (!newLeadName) return undefined;

  const emailDomain = extractEmailDomain(newLeadEmail);
  if (!emailDomain) return undefined;

  // Skip common public email domains — too many false positives
  const PUBLIC_DOMAINS = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "icloud.com", "aol.com", "protonmail.com", "mail.com",
    "live.com", "msn.com", "ymail.com", "zoho.com",
  ]);
  if (PUBLIC_DOMAINS.has(emailDomain)) return undefined;

  // Query recent leads in the same tenant for name similarity.
  // Bounded to 50 most recent leads to keep the hot path fast.
  const recentLeads = await ctx.db
    .query("leads")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .order("desc")
    .take(50);

  for (const candidate of recentLeads) {
    // Skip self
    if (candidate._id === newLeadId) continue;
    // Skip merged/converted leads (undefined status = active, safe to compare)
    if (candidate.status === "merged" || candidate.status === "converted") continue;

    const candidateDomain = extractEmailDomain(candidate.email);
    if (candidateDomain !== emailDomain) continue;

    if (areNamesSimilar(newLeadName, candidate.fullName)) {
      console.log(
        `[Pipeline:Identity] Potential duplicate detected | newLeadId=${newLeadId} candidateLeadId=${candidate._id} domain=${emailDomain}`,
      );
      return candidate._id;
    }
  }

  return undefined;
}
```

**Step 4: Implement `resolveLeadIdentity` function**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

/**
 * Multi-identifier lead identity resolution chain.
 *
 * Priority: email > social handle > phone > new lead.
 * Each step queries the leadIdentifiers table for an exact normalized match.
 * The first match wins and short-circuits.
 *
 * For backward compatibility, also checks the legacy leads.email index
 * (for leads created before Feature E deployed that lack leadIdentifier records).
 */
async function resolveLeadIdentity(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  inviteeEmail: string,
  inviteeName: string | undefined,
  inviteePhone: string | undefined,
  socialHandle: { rawValue: string; platform: SocialPlatformType } | undefined,
): Promise<IdentityResolutionResult> {
  const now = Date.now();

  // Step 1: Email match
  const normalizedEmail = normalizeEmail(inviteeEmail);
  if (normalizedEmail) {
    // First check the legacy leads.email index (backward compat with pre-Feature-E leads)
    const legacyLead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", normalizedEmail),
      )
      .unique();

    if (legacyLead) {
      console.log(
        `[Pipeline:Identity] Email match via legacy index | leadId=${legacyLead._id} email=${normalizedEmail}`,
      );
      return { lead: legacyLead, isNewLead: false, resolvedVia: "email" };
    }

    // Then check the leadIdentifiers table (for leads whose primary email was changed)
    const emailIdentifier = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", tenantId).eq("type", "email").eq("value", normalizedEmail),
      )
      .first();

    if (emailIdentifier) {
      const matchedLead = await ctx.db.get(emailIdentifier.leadId);
      if (matchedLead && matchedLead.tenantId === tenantId) {
        // Skip merged leads — follow the merge chain
        const activeLead = await followMergeChain(ctx, matchedLead);
        if (activeLead) {
          console.log(
            `[Pipeline:Identity] Email match via leadIdentifiers | leadId=${activeLead._id} email=${normalizedEmail}`,
          );
          return { lead: activeLead, isNewLead: false, resolvedVia: "email" };
        }
      }
    }
  }

  // Step 2: Social handle match
  if (socialHandle) {
    const normalizedHandle = normalizeSocialHandle(socialHandle.rawValue, socialHandle.platform);
    if (normalizedHandle) {
      const handleIdentifier = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("type", socialHandle.platform)
            .eq("value", normalizedHandle),
        )
        .first();

      if (handleIdentifier) {
        const matchedLead = await ctx.db.get(handleIdentifier.leadId);
        if (matchedLead && matchedLead.tenantId === tenantId) {
          const activeLead = await followMergeChain(ctx, matchedLead);
          if (activeLead) {
            console.log(
              `[Pipeline:Identity] Social handle match | leadId=${activeLead._id} platform=${socialHandle.platform} handle=${normalizedHandle}`,
            );
            return { lead: activeLead, isNewLead: false, resolvedVia: "social_handle" };
          }
        }
      }
    }
  }

  // Step 3: Phone match
  if (inviteePhone) {
    const normalizedPhone = normalizePhone(inviteePhone);
    if (normalizedPhone) {
      const phoneIdentifier = await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_tenantId_and_type_and_value", (q) =>
          q.eq("tenantId", tenantId).eq("type", "phone").eq("value", normalizedPhone),
        )
        .first();

      if (phoneIdentifier) {
        const matchedLead = await ctx.db.get(phoneIdentifier.leadId);
        if (matchedLead && matchedLead.tenantId === tenantId) {
          const activeLead = await followMergeChain(ctx, matchedLead);
          if (activeLead) {
            console.log(
              `[Pipeline:Identity] Phone match | leadId=${activeLead._id} phone=${normalizedPhone}`,
            );
            return { lead: activeLead, isNewLead: false, resolvedVia: "phone" };
          }
        }
      }
    }
  }

  // Step 4: No match — create a new lead
  const leadId = await ctx.db.insert("leads", {
    tenantId,
    email: inviteeEmail,
    fullName: inviteeName,
    phone: inviteePhone,
    customFields: undefined,
    status: "active",
    firstSeenAt: now,
    updatedAt: now,
  });
  const newLead = (await ctx.db.get(leadId))!;
  console.log(`[Pipeline:Identity] New lead created | leadId=${leadId}`);

  // Step 5: Check for potential duplicates (fuzzy match)
  const potentialDuplicateLeadId = await detectPotentialDuplicate(
    ctx,
    tenantId,
    inviteeName,
    inviteeEmail,
    leadId,
  );

  return {
    lead: newLead,
    isNewLead: true,
    resolvedVia: "new",
    potentialDuplicateLeadId,
  };
}
```

**Key implementation notes:**
- The email resolution checks both the legacy `leads.email` index **first** for backward compatibility. Pre-Feature-E leads don't have `leadIdentifier` records until the backfill migration runs (Phase 1B). This ensures zero regression.
- The resolution chain short-circuits on the first match. Order matters: email is the most reliable identifier, then social handle (inferred from form fields), then phone (can be shared).
- `followMergeChain` is a forward-looking helper. Feature E doesn't create merged leads, but Feature C will. The pipeline must handle merge chains from day one to avoid bugs when Feature C ships.
- `detectPotentialDuplicate` skips public email domains (Gmail, Yahoo, etc.) to avoid flooding closers with false positives. Only business/custom domain emails trigger fuzzy matching.
- The 50-lead scan limit is a deliberate trade-off: it catches recent duplicates (the most common case) while keeping mutation execution time bounded.
- All functions are file-private (not exported) — they are internal pipeline logic.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add 3 core identity resolution functions |

---

### 3C — Pipeline Integration (Replace Lead Lookup Block)

**Type:** Backend
**Parallelizable:** No — depends on 3A and 3B. This step wires the new functions into the existing handler.

**What:** Replace the existing email-only lead lookup block in the `process` handler (current lines ~169–201) with the multi-identifier identity resolution flow. This involves:
1. Loading the event type config early (before identity resolution) for custom field mapping access.
2. Extracting identifiers from custom form data via `extractIdentifiersFromCustomFields`.
3. Calling `resolveLeadIdentity()` instead of the direct email lookup.
4. Including `potentialDuplicateLeadId` in the new opportunity creation.

**Why:** This is the core integration point. Without this step, the helper functions from 3A/3B exist but are not called. This step replaces the heart of the lead lookup logic while preserving all other pipeline behavior.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify — within the `process` handler)

**How:**

**Step 1: Replace the lead lookup block**

The current code block to **remove** starts after the duplicate meeting check and `durationMinutes` calculation (line ~168) and ends before the event membership extraction (line ~203). It includes the `leads` query, `extractQuestionsAndAnswers`, `extractUtmParams`, and the `if (!lead) { insert } else { patch }` block.

**Remove this entire block** (lines ~169–201 of the current file):

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// === REMOVE THIS BLOCK ===

    let lead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", inviteeEmail),
      )
      .unique();

    const latestCustomFields = extractQuestionsAndAnswers(payload.questions_and_answers);

    const utmParams = extractUtmParams(payload.tracking);
    console.log(`[Pipeline:invitee.created] UTM extraction | hasUtm=${!!utmParams} source=${utmParams?.utm_source ?? "none"} medium=${utmParams?.utm_medium ?? "none"} campaign=${utmParams?.utm_campaign ?? "none"}`);

    if (!lead) {
      const leadId = await ctx.db.insert("leads", {
        tenantId,
        email: inviteeEmail,
        fullName: inviteeName,
        phone: inviteePhone,
        customFields: latestCustomFields,
        firstSeenAt: now,
        updatedAt: now,
      });
      lead = (await ctx.db.get(leadId))!;
      console.log(`[Pipeline:invitee.created] Lead created | leadId=${leadId}`);
    } else {
      console.log(`[Pipeline:invitee.created] Lead updated | leadId=${lead._id}`);
      await ctx.db.patch(lead._id, {
        fullName: inviteeName || lead.fullName,
        phone: inviteePhone || lead.phone,
        customFields: mergeCustomFields(lead.customFields, latestCustomFields),
        updatedAt: now,
      });
    }

// === END REMOVE ===
```

**Replace with** the following block in the same location:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// === REPLACEMENT BLOCK (Feature E: Multi-Identifier Identity Resolution) ===

    const latestCustomFields = extractQuestionsAndAnswers(payload.questions_and_answers);

    const utmParams = extractUtmParams(payload.tracking);
    console.log(`[Pipeline:invitee.created] UTM extraction | hasUtm=${!!utmParams} source=${utmParams?.utm_source ?? "none"} medium=${utmParams?.utm_medium ?? "none"} campaign=${utmParams?.utm_campaign ?? "none"}`);

    // === Feature E: Extract identifiers from custom form data ===
    // Must happen BEFORE identity resolution so the social handle is available for lookup.
    // Load the event type config early using the eventTypeUri from the payload.
    let earlyEventTypeConfig: Doc<"eventTypeConfigs"> | null = null;
    if (eventTypeUri) {
      const configCandidates = await ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri),
        )
        .take(8);
      earlyEventTypeConfig =
        configCandidates.length === 0
          ? null
          : configCandidates.reduce((best, row) =>
              row.createdAt < best.createdAt ? row : best,
            );
    }

    const extractedIdentifiers = extractIdentifiersFromCustomFields(
      latestCustomFields,
      earlyEventTypeConfig,
    );

    // Use phone override from custom fields if available, otherwise use Calendly's phone
    const effectivePhone = extractedIdentifiers.phoneOverride ?? inviteePhone;

    // === Feature E: Multi-identifier identity resolution ===
    const resolution = await resolveLeadIdentity(
      ctx,
      tenantId,
      inviteeEmail,
      inviteeName,
      effectivePhone,
      extractedIdentifiers.socialHandle,
    );

    let lead = resolution.lead;
    console.log(
      `[Pipeline:Identity] Resolution complete | leadId=${lead._id} isNew=${resolution.isNewLead} via=${resolution.resolvedVia} potentialDuplicate=${resolution.potentialDuplicateLeadId ?? "none"}`,
    );

    // If existing lead, update fields (existing behavior, preserved)
    if (!resolution.isNewLead) {
      await ctx.db.patch(lead._id, {
        fullName: inviteeName || lead.fullName,
        phone: effectivePhone || lead.phone,
        customFields: mergeCustomFields(lead.customFields, latestCustomFields),
        updatedAt: Date.now(),
      });
    } else if (latestCustomFields) {
      // New lead: set custom fields (they were not set in resolveLeadIdentity)
      await ctx.db.patch(lead._id, {
        customFields: latestCustomFields,
      });
    }
    // === End Feature E: Identity Resolution ===

// === END REPLACEMENT ===
```

**Step 2: Modify the new opportunity creation to include `potentialDuplicateLeadId`**

Find the `else` branch that creates a new opportunity (current line ~321 in the existing file). Add `potentialDuplicateLeadId` to the insert:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// BEFORE (inside the else branch that creates a new opportunity):
    } else {
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: now,
        updatedAt: now,
        utmParams,
      });

// AFTER (add potentialDuplicateLeadId):
    } else {
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: now,
        updatedAt: now,
        utmParams,
        potentialDuplicateLeadId: resolution.potentialDuplicateLeadId,
      });
```

**Key implementation notes:**
- The early event type config lookup duplicates the config resolution that happens later in the pipeline. This is intentional — identity resolution needs the config before the main config lookup. Convex's query layer caches reads within the same transaction, so this does not double the I/O.
- `effectivePhone` prefers the custom field phone override over Calendly's `text_reminder_number`. This handles cases where the closer's Calendly form has a dedicated phone field that's more reliable than Calendly's built-in.
- The `potentialDuplicateLeadId` is only set on **new** opportunities (not follow-up reuses). Follow-up opportunities already have a known lead, so duplicate detection is irrelevant.
- Custom fields are handled differently for new vs. existing leads: new leads get `customFields` set via a patch (since `resolveLeadIdentity` doesn't include them), while existing leads get `mergeCustomFields` (preserving existing data + adding new).
- The `let lead = resolution.lead` pattern preserves the mutable `lead` variable that the rest of the handler depends on. The handler below this point (closer assignment, event type config, follow-up detection) continues to use `lead._id` as before.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Replace lead lookup block, add `potentialDuplicateLeadId` to opportunity creation |

---

### 3D — Lead Identifier Creation & End-to-End Wiring

**Type:** Backend
**Parallelizable:** No — depends on 3C (the pipeline integration must be in place, and the meeting must be created so we have a `meetingId` for provenance tracking).

**What:** Add the `createLeadIdentifiers` function and call it after meeting creation in the `process` handler. This function creates `leadIdentifier` records for every identifier found in the booking (email always, phone and social handle when present), building up the identity corpus incrementally.

**Why:** Without this step, the `leadIdentifiers` table stays empty. Every booking must populate it so that subsequent bookings can resolve leads via the identity resolution chain (3B). The call must happen after meeting creation because `sourceMeetingId` provides provenance tracking.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify — within the `process` handler)

**How:**

**Step 1: Add `createLeadIdentifiers` function**

Add this function alongside the other helper functions (before the `process` handler):

```typescript
// Path: convex/pipeline/inviteeCreated.ts (new helper function)

/**
 * Create leadIdentifier records for all identifiers found in this booking.
 * Skips creation if an identical record already exists (idempotent via upsertLeadIdentifier).
 *
 * Called after meeting creation so we have a meetingId for provenance tracking.
 */
async function createLeadIdentifiers(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  meetingId: Id<"meetings">,
  email: string,
  phone: string | undefined,
  socialHandle: { rawValue: string; platform: SocialPlatformType } | undefined,
): Promise<void> {
  const now = Date.now();

  // Email identifier (always created, "verified" confidence)
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    await upsertLeadIdentifier(ctx, {
      tenantId,
      leadId,
      type: "email",
      value: normalizedEmail,
      rawValue: email,
      source: "calendly_booking",
      sourceMeetingId: meetingId,
      confidence: "verified",
      createdAt: now,
    });
  }

  // Phone identifier ("verified" from Calendly's text_reminder_number or custom field)
  if (phone) {
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone) {
      await upsertLeadIdentifier(ctx, {
        tenantId,
        leadId,
        type: "phone",
        value: normalizedPhone,
        rawValue: phone,
        source: "calendly_booking",
        sourceMeetingId: meetingId,
        confidence: "verified",
        createdAt: now,
      });
    }
  }

  // Social handle identifier ("inferred" because it comes from a form field mapping)
  if (socialHandle) {
    const normalizedHandle = normalizeSocialHandle(
      socialHandle.rawValue,
      socialHandle.platform,
    );
    if (normalizedHandle) {
      await upsertLeadIdentifier(ctx, {
        tenantId,
        leadId,
        type: socialHandle.platform,
        value: normalizedHandle,
        rawValue: socialHandle.rawValue,
        source: "calendly_booking",
        sourceMeetingId: meetingId,
        confidence: "inferred",
        createdAt: now,
      });

      // Update denormalized socialHandles on the lead
      await updateLeadSocialHandles(ctx, leadId, socialHandle.platform, normalizedHandle);
    }
  }
}
```

**Step 2: Call `createLeadIdentifiers` in the process handler**

Insert this call **after** `updateOpportunityMeetingRefs` and **before** the Feature F auto-discovery block:

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// Insert AFTER this existing line:
    await updateOpportunityMeetingRefs(ctx, opportunityId);
    console.log(`[Pipeline:invitee.created] Updated opportunity meeting refs | opportunityId=${opportunityId}`);

// INSERT this new block:
    // === Feature E: Create leadIdentifier records ===
    // Runs after the meeting is created so we have a meetingId for provenance tracking.
    await createLeadIdentifiers(
      ctx,
      tenantId,
      lead._id,
      meetingId,
      inviteeEmail,
      effectivePhone,
      extractedIdentifiers.socialHandle,
    );
    console.log(`[Pipeline:Identity] Lead identifiers created | leadId=${lead._id} meetingId=${meetingId}`);
    // === End Feature E: Create leadIdentifier records ===

// BEFORE this existing block:
    // === Feature F: Auto-discover custom field keys ===
```

**Step 3: Verify the complete processing order**

After integration, the `process` handler should follow this order:

```
 1. Validate event not processed, extract fields (existing)
 2. Duplicate meeting check by calendlyEventUri (existing)
 3. Extract custom fields — extractQuestionsAndAnswers (existing)
 4. UTM extraction (Feature G — deployed)
 5. Early event type config lookup for field mappings (Feature E — NEW)
 6. Extract identifiers from custom fields via field mappings (Feature E — NEW)
 7. Multi-identifier identity resolution (Feature E — NEW, replaces old lead lookup)
 8. Update lead fields (existing, modified to use effectivePhone)
 9. Resolve assigned closer (existing)
10. Event type config lookup/creation (existing)
11. Follow-up opportunity detection (existing)
12. Create/reuse opportunity (existing, modified: includes potentialDuplicateLeadId)
13. Create meeting (existing)
14. Update denormalized meeting refs (existing)
15. Create leadIdentifier records (Feature E — NEW)
16. Auto-discover custom field keys (Feature F — deployed)
17. Mark processed (existing)
```

**Key implementation notes:**
- `createLeadIdentifiers` must run **after** meeting insertion (step 13) so that `meetingId` is available for `sourceMeetingId` provenance tracking. This ordering is essential.
- The `effectivePhone` variable (defined in 3C) is reused here — it represents the best phone number available (custom field override or Calendly's built-in).
- Social handle confidence is `"inferred"` (not `"verified"`) because it comes from a form field mapping — the admin configured which field is the social handle, but the value could be anything the invitee typed.
- Email confidence is `"verified"` because Calendly validates the email address during booking.
- Idempotency: If the same webhook is processed twice (rare but possible), `upsertLeadIdentifier` skips duplicate records. The duplicate meeting check at the top of the handler provides the primary guard, but the upsert provides a secondary safety net.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add `createLeadIdentifiers` function and wire it into the handler after meeting creation |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | 3A, 3B, 3C, 3D |
| `convex/lib/normalization.ts` | — (consumed, not modified) | — |

---

## Notes for Implementer

- **Backward compatibility:** The legacy `leads.email` lookup in `resolveLeadIdentity` ensures zero regression. Pre-Feature-E leads (without `leadIdentifier` records) are found via the existing `by_tenantId_and_email` index. New leads get `leadIdentifier` records created, so future lookups use the `leadIdentifiers` table.
- **Read the Convex AI guidelines** (`convex/_generated/ai/guidelines.md`) before implementing — ensure all `ctx.db.insert` calls use properly typed arguments, all queries use indexed lookups (never `.filter()`), and all results are bounded.
- **Type safety:** The `upsertLeadIdentifier` function types its `type` parameter as the exact union from the schema. If new identifier types are added to the schema, the function must be updated. TypeScript will flag this.
- **Pipeline merge order:** Per the feature parallelization strategy, Feature E's pipeline integration runs after Feature A's changes. If Feature A is not yet merged, the line numbers may differ. Use the code patterns (function names, comments) rather than line numbers to locate insertion points.
- **Convex function limits:** The identity resolution chain performs at most 4 indexed lookups (1 legacy email, 1 email identifier, 1 social, 1 phone) + 1 bounded scan (50 leads for fuzzy match). This is well within Convex's mutation limits for bytes read and execution time.
- **Treat `status: undefined` as `"active"`:** In `detectPotentialDuplicate`, leads with `status === undefined` (pre-Feature-E) are not skipped. Only explicitly `"merged"` or `"converted"` leads are excluded.
- **After implementation:** Run the `convex-performance-audit` skill to verify the identity resolution hot path stays within Convex function limits. Run the `simplify` skill to review the modified file for code quality.
- **Logging:** All new log messages use `[Pipeline:Identity]` tag for grep-ability, consistent with `[Pipeline:invitee.created]` used in existing log lines.
