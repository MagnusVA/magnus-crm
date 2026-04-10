# Phase 3 — Backend: Field Mapping Mutation & Aggregation Query

**Goal:** Provide the backend functions that the Field Mappings UI (Phase 4) needs: a mutation to save `customFieldMappings` on an event type config, and a query that returns configs enriched with booking stats (count, last booking date, discovered field count). After this phase, an admin can programmatically save field mappings and retrieve configs with stats — the UI just needs to wire up to these endpoints.

**Prerequisite:** Phase 1 complete — `customFieldMappings` and `knownCustomFieldKeys` fields deployed on `eventTypeConfigs`.

**Runs in PARALLEL with:** Phase 2 (Auto-Discovery). Phase 3 modifies `convex/eventTypeConfigs/mutations.ts` and `convex/eventTypeConfigs/queries.ts`; Phase 2 modifies `convex/pipeline/inviteeCreated.ts`. **Zero file overlap.** Both can start immediately after Phase 1 deploys.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 3 → Phase 4). Start as early as possible after Phase 1 completes. Phase 4 (Settings UI) blocks on this phase's mutation and query being deployed.

**Skills to invoke:**
- `convex-performance-audit` — The `getEventTypeConfigsWithStats` query iterates opportunities. Review for efficiency if the tenant has many opportunities. Apply post-deploy if Convex insights shows high read costs.

**Acceptance Criteria:**
1. A new `updateCustomFieldMappings` public mutation exists in `convex/eventTypeConfigs/mutations.ts`.
2. The mutation requires `tenant_master` or `tenant_admin` role (enforced by `requireTenantUser`).
3. The mutation validates tenant isolation: `config.tenantId === tenantId` check prevents cross-tenant writes.
4. The mutation validates that mapped field names exist in `knownCustomFieldKeys` when keys are available.
5. The mutation validates that `socialHandleType` is required when `socialHandleField` is set.
6. The mutation clears `socialHandleType` when `socialHandleField` is cleared (normalization).
7. The mutation validates that `socialHandleField !== phoneField` (no double-mapping the same question).
8. A new `getEventTypeConfigsWithStats` public query exists in `convex/eventTypeConfigs/queries.ts`.
9. The query returns each config enriched with `bookingCount` (number), `lastBookingAt` (number | undefined), and `fieldCount` (number).
10. Both functions have complete Convex argument validators.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (updateCustomFieldMappings mutation) ────────────────────────────────┐
                                                                       ├── 3C (Deploy & verify)
3B (getEventTypeConfigsWithStats query)  ───────────────────────────────┘
```

**Optimal execution:**
1. Start 3A and 3B in parallel (they modify different functions in different files within `convex/eventTypeConfigs/`).
2. Once both are done → run 3C (deploy and type-check).

**Estimated time:** 1-1.5 hours

---

## Subphases

### 3A — Add `updateCustomFieldMappings` Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of 3B. Modifies `convex/eventTypeConfigs/mutations.ts`; 3B modifies `convex/eventTypeConfigs/queries.ts`. No file overlap.

**What:** Add a new `updateCustomFieldMappings` public mutation to `convex/eventTypeConfigs/mutations.ts` that validates and persists custom field mapping configuration for an event type.

**Why:** The Field Mapping Dialog (Phase 4) needs a backend endpoint to save the admin's mapping selections. This mutation is separate from the existing `upsertEventTypeConfig` mutation because it serves a different admin workflow (identity mapping vs. payment/round-robin config) and has different validation rules.

**Where:**
- `convex/eventTypeConfigs/mutations.ts` (modify — append new mutation)

**How:**

**Step 1: Add validator definitions at the top of the file (after the existing `paymentLinkValidator`)**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts
// Add after the existing paymentLinkValidator (line 6-10):

const socialHandleTypeValidator = v.union(
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("twitter"),
  v.literal("other_social"),
);

const customFieldMappingsValidator = v.object({
  socialHandleField: v.optional(v.string()),
  socialHandleType: v.optional(socialHandleTypeValidator),
  phoneField: v.optional(v.string()),
});
```

**Step 2: Add the mutation at the bottom of the file (after the existing `upsertEventTypeConfig` mutation)**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts
// Append after the closing of upsertEventTypeConfig (after line 143):

/**
 * Update the custom field mappings for an event type config.
 * Admin-only: configures which Calendly form questions map to CRM identity fields.
 * Feature E (Lead Identity Resolution) reads these mappings during pipeline processing.
 */
export const updateCustomFieldMappings = mutation({
  args: {
    eventTypeConfigId: v.id("eventTypeConfigs"),
    customFieldMappings: customFieldMappingsValidator,
  },
  handler: async (ctx, { eventTypeConfigId, customFieldMappings }) => {
    console.log("[EventTypeConfig] updateCustomFieldMappings called", {
      eventTypeConfigId,
      customFieldMappings,
    });
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Load and validate ownership
    const config = await ctx.db.get(eventTypeConfigId);
    if (!config) {
      throw new Error("Event type configuration not found.");
    }
    if (config.tenantId !== tenantId) {
      // Deliberately vague error to avoid leaking info about other tenants
      throw new Error("Event type configuration not found.");
    }

    // Validate that mapped fields exist in knownCustomFieldKeys (if available)
    const knownKeys = config.knownCustomFieldKeys ?? [];
    if (knownKeys.length > 0) {
      if (
        customFieldMappings.socialHandleField &&
        !knownKeys.includes(customFieldMappings.socialHandleField)
      ) {
        throw new Error(
          `Social handle field "${customFieldMappings.socialHandleField}" is not a known form field for this event type.`,
        );
      }
      if (
        customFieldMappings.phoneField &&
        !knownKeys.includes(customFieldMappings.phoneField)
      ) {
        throw new Error(
          `Phone field "${customFieldMappings.phoneField}" is not a known form field for this event type.`,
        );
      }
    }

    // Validate socialHandleType is required when socialHandleField is set
    if (
      customFieldMappings.socialHandleField &&
      !customFieldMappings.socialHandleType
    ) {
      throw new Error(
        "Social handle platform type is required when a social handle field is selected.",
      );
    }

    // Validate no double-mapping (same question for both social handle and phone)
    if (
      customFieldMappings.socialHandleField &&
      customFieldMappings.phoneField &&
      customFieldMappings.socialHandleField === customFieldMappings.phoneField
    ) {
      throw new Error(
        "Social handle field and phone field cannot be the same question.",
      );
    }

    // Normalize: clear socialHandleType if socialHandleField is cleared
    const normalizedMappings = {
      socialHandleField: customFieldMappings.socialHandleField || undefined,
      socialHandleType: customFieldMappings.socialHandleField
        ? customFieldMappings.socialHandleType
        : undefined,
      phoneField: customFieldMappings.phoneField || undefined,
    };

    await ctx.db.patch(eventTypeConfigId, {
      customFieldMappings: normalizedMappings,
    });

    console.log("[EventTypeConfig] updateCustomFieldMappings saved", {
      configId: eventTypeConfigId,
      mappings: normalizedMappings,
    });
  },
});
```

**Key implementation notes:**
- **Tenant isolation:** The `config.tenantId !== tenantId` check is critical. Without it, a user could modify another tenant's config by supplying a valid `eventTypeConfigId` from a different tenant. The error message is deliberately vague ("not found" instead of "wrong tenant") to avoid leaking information.
- **Field existence validation:** When `knownKeys.length > 0`, we validate that the selected field names actually exist in the discovered keys. This prevents typos or stale field references. When `knownKeys` is empty (no bookings yet), we allow any field name — the admin might be pre-configuring before the first booking arrives.
- **Normalization:** Empty strings from the UI (when the admin selects "(none)") are normalized to `undefined` to keep the stored object clean. `socialHandleType` is automatically cleared when `socialHandleField` is cleared to prevent orphaned type values.
- **No `programField` yet:** The v0.5 spec mentions a `programField` in early mockups, but it's deferred (no downstream consumer). The schema and mutation can be extended later.
- **Logging follows the codebase standard:** `[EventTypeConfig]` tag with structured parameters.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/eventTypeConfigs/mutations.ts` | Modify | Add validators + `updateCustomFieldMappings` mutation |

---

### 3B — Add `getEventTypeConfigsWithStats` Query

**Type:** Backend
**Parallelizable:** Yes — independent of 3A. Modifies `convex/eventTypeConfigs/queries.ts`; 3A modifies `convex/eventTypeConfigs/mutations.ts`. No file overlap.

**What:** Add a new `getEventTypeConfigsWithStats` public query to `convex/eventTypeConfigs/queries.ts` that returns all event type configs for the tenant, enriched with booking count, last booking timestamp, and discovered field count.

**Why:** The Field Mappings Tab (Phase 4) displays a card list with per-event-type stats: "14 bookings · Last booking: 2 days ago · 6 form fields". These stats are computed by aggregating across the `opportunities` table (which links to `eventTypeConfigs` via `eventTypeConfigId`). The existing `listEventTypeConfigs` query returns raw configs without stats.

**Where:**
- `convex/eventTypeConfigs/queries.ts` (modify — append new query)

**How:**

**Step 1: Add the query at the bottom of the file (after the existing `listEventTypeConfigs` query)**

```typescript
// Path: convex/eventTypeConfigs/queries.ts
// Append after the closing of listEventTypeConfigs (after line 37):

/**
 * List event type configs with booking stats for the Field Mappings tab.
 * Returns configs enriched with:
 * - bookingCount: number of opportunities linked to this event type
 * - lastBookingAt: timestamp of the most recent meeting (via denormalized latestMeetingAt)
 * - fieldCount: number of discovered custom field keys
 */
export const getEventTypeConfigsWithStats = query({
  args: {},
  handler: async (ctx) => {
    console.log("[EventTypeConfig] getEventTypeConfigsWithStats called");
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Load all configs for the tenant
    const configs = [];
    for await (const config of ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      configs.push(config);
    }

    // For each config, count opportunities and find the most recent booking
    const results = await Promise.all(
      configs.map(async (config) => {
        let bookingCount = 0;
        let lastBookingAt: number | undefined;

        // Iterate opportunities for this tenant, filter by eventTypeConfigId.
        // Uses the by_tenantId index. For tenants with <500 opportunities this is fast.
        for await (const opp of ctx.db
          .query("opportunities")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
          if (opp.eventTypeConfigId === config._id) {
            bookingCount++;
            // Use denormalized latestMeetingAt as proxy for last booking date
            // (populated by updateOpportunityMeetingRefs helper)
            if (
              opp.latestMeetingAt &&
              (lastBookingAt === undefined || opp.latestMeetingAt > lastBookingAt)
            ) {
              lastBookingAt = opp.latestMeetingAt;
            }
          }
        }

        return {
          ...config,
          bookingCount,
          lastBookingAt,
          fieldCount: config.knownCustomFieldKeys?.length ?? 0,
        };
      }),
    );

    console.log("[EventTypeConfig] getEventTypeConfigsWithStats result", {
      count: results.length,
    });
    return results;
  },
});
```

**Key implementation notes:**
- **Aggregation approach:** We iterate all opportunities for the tenant and filter by `eventTypeConfigId` in memory. This is a table scan, but it's bounded by the tenant's opportunity count. For the current single-tenant production state (likely <200 opportunities), this is fine.
- **Performance ceiling:** If a tenant grows to 1,000+ opportunities, this query will read too many documents. At that point, add an index `by_tenantId_and_eventTypeConfigId` on `opportunities` and switch to an indexed query per config. This is a **non-goal for Feature F** — apply `convex-performance-audit` skill post-deployment if Convex insights shows degradation.
- **Why `latestMeetingAt` instead of scanning meetings:** The `opportunities` table already has a denormalized `latestMeetingAt` field (maintained by `updateOpportunityMeetingRefs()` on every new meeting). Using this avoids a second table scan on `meetings`.
- **`fieldCount` derivation:** Simply `knownCustomFieldKeys?.length ?? 0`. This is a property of the config document itself, not an aggregation.
- **Auth guard:** Same `requireTenantUser` pattern as all other tenant-scoped queries. Only `tenant_master` and `tenant_admin` can access this query.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/eventTypeConfigs/queries.ts` | Modify | Add `getEventTypeConfigsWithStats` query |

---

### 3C — Deploy and Verify Type Compilation

**Type:** Config / Manual
**Parallelizable:** No — depends on 3A and 3B.

**What:** Deploy the new mutation and query, then verify that TypeScript compilation passes and the functions are accessible via the generated API.

**Why:** Phase 4 (Settings UI) will import `api.eventTypeConfigs.mutations.updateCustomFieldMappings` and `api.eventTypeConfigs.queries.getEventTypeConfigsWithStats`. These imports only work after deployment regenerates `convex/_generated/api.d.ts`.

**Where:**
- Terminal (commands only)

**How:**

**Step 1: Deploy**

```bash
npx convex dev
```

Verify: no errors. New functions visible in Convex dashboard → Functions tab.

**Step 2: Type check**

```bash
pnpm tsc --noEmit
```

Verify: zero errors.

**Step 3: Verify API accessibility**

In any TypeScript file (or in the editor's autocomplete), confirm these imports resolve:

```typescript
import { api } from "@/convex/_generated/api";

// These should exist and have correct argument types:
api.eventTypeConfigs.mutations.updateCustomFieldMappings
api.eventTypeConfigs.queries.getEventTypeConfigsWithStats
```

**Step 4: Quick functional smoke test (optional but recommended)**

Use the Convex dashboard → Function Runner to call `getEventTypeConfigsWithStats` with no arguments (auth context from logged-in admin). Verify it returns the expected configs with `bookingCount`, `lastBookingAt`, and `fieldCount` fields.

If Phase 2 has already deployed, configs that received bookings with custom questions should show `fieldCount > 0` and a populated `knownCustomFieldKeys` array.

**Key implementation notes:**
- If Phase 2 has already deployed, the `knownCustomFieldKeys` field will be populated on some configs. The `getEventTypeConfigsWithStats` query correctly handles both populated and empty states.
- If Phase 2 has NOT yet deployed, all configs will have `knownCustomFieldKeys: undefined` and `fieldCount: 0`. This is the expected initial state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/api.d.ts` | Auto-generated | Updated by `npx convex dev` — includes new functions |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/eventTypeConfigs/mutations.ts` | Modify | 3A |
| `convex/eventTypeConfigs/queries.ts` | Modify | 3B |
| `convex/_generated/api.d.ts` | Auto-generated | 3C |
