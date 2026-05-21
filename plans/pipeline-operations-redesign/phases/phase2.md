# Phase 2 — UTM Attribution Model

**Goal:** Add the tenant-scoped attribution registry, booked-program mapping, write-time attribution resolution, sold-program caches, and production-safe backfills needed before Operations can expose attribution and program filters.

**Prerequisite:** Phase 1A route stub is available if frontend settings links are added in the same release. Read `convex/_generated/ai/guidelines.md`, `.docs/convex/database/schemas.md`, `.docs/convex/database/indexes-and-query-performance.md`, `.docs/convex/database/paginated-queries.md`, and the `convex-migration-helper` skill before implementation.

**Runs in PARALLEL with:** Phase 1 after the Operations route stub exists. Phase 3 and Phase 4 should not enable attribution/program filters until this phase is deployed, dual-writing, and backfilled.

**Skills to invoke:**
- `convex-migration-helper` — Schema widen, dual-write, resumable backfills, dry runs, production verification, and delayed narrowing.
- `convex-performance-audit` — New registry indexes, meeting indexes, and Operations filter paths must stay index-backed.
- `shadcn` — Settings tabs, CRUD dialogs, selects, alerts, tables, and badges should use existing primitives.
- `frontend-design` — Attribution settings should be dense configuration UI, not a landing page.
- `next-best-practices` — Settings remains a client boundary under a server page/Suspense pattern.

**Acceptance Criteria:**
1. `convex/schema.ts` includes attribution registry tables and only optional additions to existing production tables.
2. Attribution alias matching stores raw UTM strings for audit and normalized values for indexed lookup.
3. Admins can create, update, soft-disable, and list attribution teams, DM closers, and aliases scoped to their own tenant only.
4. `invitee.created` writes meeting-level booked-program fields and attribution resolution fields for every new external booking.
5. The first external booking patches opportunity-level `firstBookingProgram*`, `firstBookedAt`, `firstMeeting*`, and resolved attribution fields without copying internal `utm_source=ptdom` follow-up UTMs.
6. Event type configs can store `bookingProgramId`, `bookingProgramName`, `bookingProgramMappingStatus`, and `bookingBaseUrl`.
7. Payment/customer conversion paths refresh `soldProgramId` and `soldProgramName` caches on opportunities and meetings without treating booked program as sold program.
8. Settings -> Attribution shows recent unmapped UTM values and the booked-program link matrix without exposing CRM account controls for DM closers.
9. Backfills support dry-run mode and report rows scanned, rows changed, unmapped count, internal count, and truncated UTM count.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (schema widen + validators) ───────────────┬── 2B (resolver + registry CRUD)
                                              ├── 2C (event type booked program API)
                                              └── 2D (settings UI)

2B + 2C complete ─────────────────────────────── 2E (pipeline/payment dual-write)

2E complete ──────────────────────────────────── 2F (backfills + verification)
```

**Optimal execution:**
1. Complete 2A first and run Convex codegen/types.
2. Implement resolver/CRUD and event type mapping in parallel.
3. Build Settings UI once public queries/mutations exist.
4. Add dual-write to webhooks and payment/customer paths.
5. Run dry-run backfills, then production batches, then verification.

**Estimated time:** 4-6 days

---

## Subphases

### 2A — Schema Widen and Validators

**Type:** Backend
**Parallelizable:** No — all backend and frontend work imports generated types from these tables and fields.

**What:** Add attribution validators, three registry tables, booked-program fields, resolved attribution cache fields, first-booking fields, sold-program cache fields, and index support.

**Why:** Convex schema validation rejects required field additions on existing rows. This phase must widen first with optional fields and defer any narrowing until a later verified production window.

**Where:**
- `convex/lib/attribution/validators.ts` (new)
- `convex/schema.ts` (modify)

**How:**

**Step 1: Create shared validators.**

```typescript
// Path: convex/lib/attribution/validators.ts
import { v } from "convex/values";

export const attributionResolutionValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
  v.literal("internal"),
  v.literal("none"),
);

export const bookingProgramMappingStatusValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
);

export const attributionAliasScopeValidator = v.union(
  v.literal("pair"),
  v.literal("source"),
  v.literal("medium"),
);
```

**Step 2: Add registry tables to `convex/schema.ts`.**

```typescript
// Path: convex/schema.ts
import {
  attributionAliasScopeValidator,
  attributionResolutionValidator,
  bookingProgramMappingStatusValidator,
} from "./lib/attribution/validators";

attributionTeams: defineTable({
  tenantId: v.id("tenants"),
  slug: v.string(),
  displayName: v.string(),
  utmSource: v.string(),
  normalizedUtmSource: v.string(),
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_slug", ["tenantId", "slug"])
  .index("by_tenantId_and_normalizedUtmSource", [
    "tenantId",
    "normalizedUtmSource",
  ]),

dmClosers: defineTable({
  tenantId: v.id("tenants"),
  teamId: v.id("attributionTeams"),
  slug: v.string(),
  displayName: v.string(),
  utmMedium: v.string(),
  normalizedUtmMedium: v.string(),
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_teamId", ["tenantId", "teamId"])
  .index("by_tenantId_and_slug", ["tenantId", "slug"])
  .index("by_tenantId_and_normalizedUtmMedium", [
    "tenantId",
    "normalizedUtmMedium",
  ]),

attributionAliases: defineTable({
  tenantId: v.id("tenants"),
  scope: attributionAliasScopeValidator,
  utmSource: v.optional(v.string()),
  utmMedium: v.optional(v.string()),
  normalizedUtmSource: v.optional(v.string()),
  normalizedUtmMedium: v.optional(v.string()),
  teamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  isCanonical: v.boolean(),
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_scope_and_normalizedUtmSource", [
    "tenantId",
    "scope",
    "normalizedUtmSource",
  ])
  .index("by_tenantId_and_scope_and_normalizedUtmMedium", [
    "tenantId",
    "scope",
    "normalizedUtmMedium",
  ])
  .index("by_tenantId_and_scope_and_normalizedUtmSource_and_normalizedUtmMedium", [
    "tenantId",
    "scope",
    "normalizedUtmSource",
    "normalizedUtmMedium",
  ]),
```

**Step 3: Widen existing tables with optional fields only.**

```typescript
// Path: convex/schema.ts
eventTypeConfigs: defineTable({
  // Existing fields remain unchanged.
  bookingProgramId: v.optional(v.id("tenantPrograms")),
  bookingProgramName: v.optional(v.string()),
  bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
  bookingBaseUrl: v.optional(v.string()),
  bookingUrlSource: v.optional(
    v.union(v.literal("admin_entered"), v.literal("imported_sheet")),
  ),
  updatedAt: v.optional(v.number()),
})
  // Existing indexes remain unchanged.
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_calendlyEventTypeUri", [
    "tenantId",
    "calendlyEventTypeUri",
  ])
  .index("by_tenantId_and_bookingProgramId", [
    "tenantId",
    "bookingProgramId",
  ]),
```

```typescript
// Path: convex/schema.ts
opportunities: defineTable({
  // Existing fields remain unchanged.
  firstBookingProgramId: v.optional(v.id("tenantPrograms")),
  firstBookingProgramName: v.optional(v.string()),
  firstBookingProgramMappingStatus: v.optional(
    bookingProgramMappingStatusValidator,
  ),
  soldProgramId: v.optional(v.id("tenantPrograms")),
  soldProgramName: v.optional(v.string()),
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  attributionAliasId: v.optional(v.id("attributionAliases")),
  attributionResolution: v.optional(attributionResolutionValidator),
  attributionResolvedAt: v.optional(v.number()),
  attributionResolutionVersion: v.optional(v.number()),
  firstBookedAt: v.optional(v.number()),
  firstMeetingId: v.optional(v.id("meetings")),
  firstMeetingAt: v.optional(v.number()),
  qualifiedAt: v.optional(v.number()),
})
  .index("by_tenantId_and_source_and_qualifiedAt", [
    "tenantId",
    "source",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_attributionTeamId_and_qualifiedAt", [
    "tenantId",
    "attributionTeamId",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_dmCloserId_and_qualifiedAt", [
    "tenantId",
    "dmCloserId",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_firstBookingProgramId_and_qualifiedAt", [
    "tenantId",
    "firstBookingProgramId",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_soldProgramId_and_qualifiedAt", [
    "tenantId",
    "soldProgramId",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_firstMeetingAt", ["tenantId", "firstMeetingAt"]);
```

```typescript
// Path: convex/schema.ts
meetings: defineTable({
  // Existing fields remain unchanged.
  bookingProgramId: v.optional(v.id("tenantPrograms")),
  bookingProgramName: v.optional(v.string()),
  bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
  soldProgramId: v.optional(v.id("tenantPrograms")),
  soldProgramName: v.optional(v.string()),
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  attributionAliasId: v.optional(v.id("attributionAliases")),
  attributionResolution: v.optional(attributionResolutionValidator),
  attributionResolvedAt: v.optional(v.number()),
  attributionResolutionVersion: v.optional(v.number()),
  utmTruncated: v.optional(v.boolean()),
})
  .index("by_tenantId_and_attributionTeamId_and_scheduledAt", [
    "tenantId",
    "attributionTeamId",
    "scheduledAt",
  ])
  .index("by_tenantId_and_dmCloserId_and_scheduledAt", [
    "tenantId",
    "dmCloserId",
    "scheduledAt",
  ])
  .index("by_tenantId_and_bookingProgramId_and_scheduledAt", [
    "tenantId",
    "bookingProgramId",
    "scheduledAt",
  ])
  .index("by_tenantId_and_soldProgramId_and_scheduledAt", [
    "tenantId",
    "soldProgramId",
    "scheduledAt",
  ]);
```

**Step 4: Run Convex codegen locally.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
```

**Key implementation notes:**
- New tables are safe; optional fields on existing tables are safe.
- Do not make `bookingProgramId`, `qualifiedAt`, or attribution fields required in this phase.
- Keep raw UTM values separate from normalized values. Raw values are audit data; normalized values plus `scope` are index keys.
- The resolver must query by alias `scope`; otherwise a pair alias can be accidentally used as a source-only or medium-only fallback.
- Watch the 32-index limit on `opportunities` and `meetings`. If the limit gets tight, prefer Operations projection indexes over adding every combination to canonical tables.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/attribution/validators.ts` | Create | Shared validators |
| `convex/schema.ts` | Modify | Registry tables and optional cache fields |

---

### 2B — Normalization, Resolver, and Registry CRUD

**Type:** Backend
**Parallelizable:** Yes — depends on 2A generated types.

**What:** Implement UTM normalization, attribution resolution priority rules, and tenant-admin CRUD for teams, DM closers, and aliases.

**Why:** Operations filters need stable IDs, not raw strings. The resolver must map current and historical UTMs without rewriting immutable `utmParams`.

**Where:**
- `convex/lib/attribution/normalize.ts` (new)
- `convex/lib/attribution/resolveAttribution.ts` (new)
- `convex/attribution/teams.ts` (new)
- `convex/attribution/dmClosers.ts` (new)
- `convex/attribution/aliases.ts` (new)

**How:**

**Step 1: Normalize and clamp UTM values.**

```typescript
// Path: convex/lib/attribution/normalize.ts
const MAX_UTM_LENGTH = 256;

export function normalizeUtmValue(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) return undefined;
  return raw.toLowerCase().replace(/\s+/g, " ");
}

export function clampUtmValue(value: string | undefined) {
  if (value === undefined) {
    return { value: undefined, truncated: false };
  }
  if (value.length <= MAX_UTM_LENGTH) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, MAX_UTM_LENGTH), truncated: true };
}

export function slugifyAttributionLabel(value: string) {
  return normalizeUtmValue(value)?.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ?? "";
}
```

**Step 2: Implement resolution in priority order.**

```typescript
// Path: convex/lib/attribution/resolveAttribution.ts
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { UtmParams } from "../utmParams";
import { normalizeUtmValue } from "./normalize";

type AttributionCtx = QueryCtx | MutationCtx;

export type ResolvedAttribution = {
  resolutionStatus: "mapped" | "unmapped" | "internal" | "none";
  teamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  aliasId?: Id<"attributionAliases">;
  resolutionVersion: number;
  resolvedAt: number;
};

const RESOLUTION_VERSION = 1;

export function isInternalUtm(utm: UtmParams | undefined) {
  return normalizeUtmValue(utm?.utm_source) === "ptdom";
}

function mappedFromAlias(alias: Doc<"attributionAliases">, resolvedAt: number): ResolvedAttribution {
  return {
    resolutionStatus: "mapped",
    teamId: alias.teamId,
    dmCloserId: alias.dmCloserId,
    aliasId: alias._id,
    resolutionVersion: RESOLUTION_VERSION,
    resolvedAt,
  };
}

export async function resolveAttributionForTenant(
  ctx: AttributionCtx,
  args: { tenantId: Id<"tenants">; utmParams: UtmParams | undefined },
): Promise<ResolvedAttribution> {
  const resolvedAt = Date.now();
  const source = normalizeUtmValue(args.utmParams?.utm_source);
  const medium = normalizeUtmValue(args.utmParams?.utm_medium);

  if (!source && !medium) {
    return { resolutionStatus: "none", resolutionVersion: RESOLUTION_VERSION, resolvedAt };
  }
  if (isInternalUtm(args.utmParams)) {
    return { resolutionStatus: "internal", resolutionVersion: RESOLUTION_VERSION, resolvedAt };
  }

  if (source && medium) {
    const pairAliases = await ctx.db
      .query("attributionAliases")
      .withIndex("by_tenantId_and_scope_and_normalizedUtmSource_and_normalizedUtmMedium", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("scope", "pair")
          .eq("normalizedUtmSource", source)
          .eq("normalizedUtmMedium", medium),
      )
      .take(5);
    const pairAlias = pairAliases.find((alias) => alias.isActive);
    if (pairAlias) return mappedFromAlias(pairAlias, resolvedAt);
  }

  if (source) {
    const sourceAliases = await ctx.db
      .query("attributionAliases")
      .withIndex("by_tenantId_and_scope_and_normalizedUtmSource", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("scope", "source")
          .eq("normalizedUtmSource", source),
      )
      .take(5);
    const sourceAlias = sourceAliases.find((alias) => alias.isActive);
    if (sourceAlias) return mappedFromAlias(sourceAlias, resolvedAt);
  }

  if (medium) {
    const mediumAliases = await ctx.db
      .query("attributionAliases")
      .withIndex("by_tenantId_and_scope_and_normalizedUtmMedium", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("scope", "medium")
          .eq("normalizedUtmMedium", medium),
      )
      .take(5);
    const mediumAlias = mediumAliases.find((alias) => alias.isActive);
    if (mediumAlias) return mappedFromAlias(mediumAlias, resolvedAt);
  }

  return { resolutionStatus: "unmapped", resolutionVersion: RESOLUTION_VERSION, resolvedAt };
}
```

**Step 3: Validate ownership in CRUD mutations.**

```typescript
// Path: convex/attribution/aliases.ts
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { clampUtmValue, normalizeUtmValue } from "../lib/attribution/normalize";

export const listAliases = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await ctx.db
      .query("attributionAliases")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200);
  },
});

export const createAlias = mutation({
  args: {
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    teamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const source = clampUtmValue(args.utmSource?.trim());
    const medium = clampUtmValue(args.utmMedium?.trim());
    if (source.truncated || medium.truncated) {
      throw new Error("UTM aliases must be 256 characters or fewer.");
    }

    const normalizedUtmSource = normalizeUtmValue(source.value);
    const normalizedUtmMedium = normalizeUtmValue(medium.value);
    if (!normalizedUtmSource && !normalizedUtmMedium) {
      throw new Error("Alias must include a UTM source, medium, or both.");
    }
    const scope = normalizedUtmSource && normalizedUtmMedium
      ? "pair"
      : normalizedUtmSource
        ? "source"
        : "medium";

    let aliasTeamId = args.teamId;
    if (args.teamId) {
      const team = await ctx.db.get(args.teamId);
      if (!team || team.tenantId !== tenantId) throw new Error("Attribution team not found.");
    }
    if (args.dmCloserId) {
      const dmCloser = await ctx.db.get(args.dmCloserId);
      if (!dmCloser || dmCloser.tenantId !== tenantId) throw new Error("DM closer not found.");
      if (args.teamId && dmCloser.teamId !== args.teamId) {
        throw new Error("DM closer must belong to the selected attribution team.");
      }
      aliasTeamId = args.teamId ?? dmCloser.teamId;
    }

    const existingActive =
      scope === "pair"
        ? await ctx.db
            .query("attributionAliases")
            .withIndex(
              "by_tenantId_and_scope_and_normalizedUtmSource_and_normalizedUtmMedium",
              (q) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("scope", "pair")
                  .eq("normalizedUtmSource", normalizedUtmSource!)
                  .eq("normalizedUtmMedium", normalizedUtmMedium!),
            )
            .take(5)
        : scope === "source"
          ? await ctx.db
              .query("attributionAliases")
              .withIndex("by_tenantId_and_scope_and_normalizedUtmSource", (q) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("scope", "source")
                  .eq("normalizedUtmSource", normalizedUtmSource!),
              )
              .take(5)
          : await ctx.db
              .query("attributionAliases")
              .withIndex("by_tenantId_and_scope_and_normalizedUtmMedium", (q) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("scope", "medium")
                  .eq("normalizedUtmMedium", normalizedUtmMedium!),
              )
              .take(5);
    if (existingActive.some((alias) => alias.isActive)) {
      throw new Error("An active alias already exists for this UTM mapping.");
    }

    return await ctx.db.insert("attributionAliases", {
      tenantId,
      scope,
      utmSource: source.value,
      utmMedium: medium.value,
      normalizedUtmSource,
      normalizedUtmMedium,
      teamId: aliasTeamId,
      dmCloserId: args.dmCloserId,
      isCanonical: false,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});
```

**Key implementation notes:**
- Enforce one active alias per normalized tuple in mutation code by querying before insert. Convex cannot enforce unique indexes automatically.
- Use `scope` in every resolver and uniqueness query; never let a pair alias satisfy source-only or medium-only fallback matching.
- Never create CRM `users` or WorkOS users for DM closers.
- Mutations should emit domain/audit events with IDs and normalized values, not lead PII.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/attribution/normalize.ts` | Create | UTM normalization and clamping |
| `convex/lib/attribution/resolveAttribution.ts` | Create | Resolver priority rules |
| `convex/attribution/teams.ts` | Create | Team CRUD |
| `convex/attribution/dmClosers.ts` | Create | DM closer CRUD |
| `convex/attribution/aliases.ts` | Create | Alias CRUD |

---

### 2C — Booked Program Event Type Mapping

**Type:** Backend
**Parallelizable:** Yes — depends on 2A schema.

**What:** Extend event type config mutations and queries so each Calendly event type can be mapped to one booked program and optional booking base URL.

**Why:** Operations must distinguish booked program from sold program before a payment exists.

**Where:**
- `convex/eventTypeConfigs/mutations.ts` (modify)
- `convex/eventTypeConfigs/queries.ts` (modify)
- `convex/tenantPrograms/queries.ts` (reuse)

**How:**

**Step 1: Extend the upsert mutation args and validation.**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts
export const upsertEventTypeConfig = mutation({
  args: {
    calendlyEventTypeUri: v.string(),
    displayName: v.string(),
    paymentLinks: v.optional(v.array(paymentLinkValidator)),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    bookingBaseUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const program = args.bookingProgramId
      ? await ctx.db.get(args.bookingProgramId)
      : null;
    if (args.bookingProgramId && (!program || program.tenantId !== tenantId || program.archivedAt)) {
      throw new Error("Booked program not found.");
    }

    const bookingProgramPatch = program
      ? {
          bookingProgramId: program._id,
          bookingProgramName: program.name,
          bookingProgramMappingStatus: "mapped" as const,
        }
      : {
          bookingProgramId: undefined,
          bookingProgramName: undefined,
          bookingProgramMappingStatus: "unmapped" as const,
        };

    const bookingBaseUrl = args.bookingBaseUrl?.trim() || undefined;

    // Apply bookingProgramPatch in both existing and insert branches.
  },
});
```

**Step 2: Auto-created configs start unmapped in the pipeline.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
  tenantId,
  calendlyEventTypeUri: eventTypeUri,
  displayName: eventDisplayName,
  knownCustomFieldKeys: initialKeys,
  bookingProgramMappingStatus: "unmapped",
  createdAt: now,
  updatedAt: now,
});
```

**Step 3: Return mapping fields in Settings queries.**

```typescript
// Path: convex/eventTypeConfigs/queries.ts
export const listEventTypeConfigs = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);
  },
});
```

**Key implementation notes:**
- `bookingProgramId` maps the Calendly event type, not a payment outcome.
- Denormalize `bookingProgramName` because list rows should not join programs repeatedly.
- Event type URI remains the durable webhook join key; `bookingBaseUrl` is operator-visible validation metadata.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/eventTypeConfigs/mutations.ts` | Modify | Booked-program args and validation |
| `convex/eventTypeConfigs/queries.ts` | Modify | Return mapping status fields |
| `convex/pipeline/inviteeCreated.ts` | Modify | Auto-created configs start unmapped |

---

### 2D — Attribution Settings UI

**Type:** Frontend
**Parallelizable:** Yes — can start once 2B and 2C public APIs are shaped.

**What:** Add `Settings -> Attribution`, expose registry CRUD, and enhance Event Types settings with booked-program and booking-base-url controls.

**Why:** Admins need to normalize real UTM values, repair typos, and map Calendly booking links without engineering intervention.

**Where:**
- `convex/operations/unmappedUtms.ts` (new)
- `app/workspace/settings/_components/settings-page-client.tsx` (modify)
- `app/workspace/settings/_components/attribution-tab.tsx` (new)
- `app/workspace/settings/_components/attribution-unmapped-panel.tsx` (new)
- `app/workspace/settings/_components/booking-link-matrix.tsx` (new)
- `app/workspace/settings/_components/attribution-team-dialog.tsx` (new)
- `app/workspace/settings/_components/dm-closer-dialog.tsx` (new)
- `app/workspace/settings/_components/attribution-alias-dialog.tsx` (new)
- `app/workspace/settings/_components/event-type-config-dialog.tsx` (modify)
- `app/workspace/settings/_components/event-type-config-list.tsx` (modify)

**How:**

**Step 1: Add the tab to Settings.**

```tsx
// Path: app/workspace/settings/_components/settings-page-client.tsx
const defaultTab =
  tabParam === "event-types" ||
  tabParam === "field-mappings" ||
  tabParam === "programs" ||
  tabParam === "integrations" ||
  tabParam === "attribution"
    ? tabParam
    : "calendly";

<TabsTrigger value="attribution">Attribution</TabsTrigger>

<TabsContent value="attribution" className="mt-6">
  <AttributionTab />
</TabsContent>
```

**Step 2: Build a dense registry tab.**

```tsx
// Path: app/workspace/settings/_components/attribution-tab.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function AttributionTab() {
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const aliases = useQuery(api.attribution.aliases.listAliases, {});
  const eventTypeConfigs = useQuery(api.eventTypeConfigs.queries.listEventTypeConfigs, {});

  if (
    teams === undefined ||
    closers === undefined ||
    aliases === undefined ||
    eventTypeConfigs === undefined
  ) {
    return <AttributionTabSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>External DM attribution</AlertTitle>
        <AlertDescription>
          DM teams and DM closers are attribution records only; they do not create CRM accounts.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Aliases</CardTitle>
          <Button size="sm">New Alias</Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>UTM Source</TableHead>
                <TableHead>UTM Medium</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>DM Closer</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.map((alias) => (
                <TableRow key={alias._id}>
                  <TableCell>{alias.utmSource ?? "-"}</TableCell>
                  <TableCell>{alias.utmMedium ?? "-"}</TableCell>
                  <TableCell>{alias.teamLabel ?? "Unknown"}</TableCell>
                  <TableCell>{alias.dmCloserLabel ?? "Unknown"}</TableCell>
                  <TableCell>
                    <Badge variant={alias.isActive ? "secondary" : "outline"}>
                      {alias.isActive ? "Active" : "Disabled"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 3: Add booked-program controls to Event Type dialog.**

```tsx
// Path: app/workspace/settings/_components/event-type-config-dialog.tsx
const programs = useQuery(api.tenantPrograms.queries.listPrograms, {});

<Field>
  <FieldLabel>Booked Program</FieldLabel>
  <Select
    value={bookingProgramId ?? "unmapped"}
    onValueChange={(value) =>
      setBookingProgramId(value === "unmapped" ? undefined : (value as Id<"tenantPrograms">))
    }
  >
    <SelectTrigger>
      <SelectValue placeholder="Select booked program" />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectItem value="unmapped">Unmapped</SelectItem>
        {programs?.map((program) => (
          <SelectItem key={program._id} value={program._id}>
            {program.name}
          </SelectItem>
        ))}
      </SelectGroup>
    </SelectContent>
  </Select>
</Field>

<Field>
  <FieldLabel htmlFor="booking-base-url">Booking Base URL</FieldLabel>
  <Input
    id="booking-base-url"
    value={bookingBaseUrl}
    onChange={(event) => setBookingBaseUrl(event.target.value)}
    placeholder="https://calendly.com/..."
  />
</Field>
```

**Step 4: Add the recent unmapped UTM query used by Settings and Operations health.**

```typescript
// Path: convex/operations/unmappedUtms.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listRecentUnmappedUtms = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", since),
      )
      .order("desc")
      .take(200);

    return meetings
      .filter((meeting) => meeting.attributionResolution === "unmapped")
      .map((meeting) => ({
        meetingId: meeting._id,
        scheduledAt: meeting.scheduledAt,
        utmSource: meeting.utmParams?.utm_source ?? null,
        utmMedium: meeting.utmParams?.utm_medium ?? null,
      }))
      .slice(0, 25);
  },
});
```

**Step 5: Render the booked-program link matrix and unmapped panel in the Attribution tab.**

```tsx
// Path: app/workspace/settings/_components/attribution-tab.tsx
import { AttributionUnmappedPanel } from "./attribution-unmapped-panel";
import { BookingLinkMatrix } from "./booking-link-matrix";

<AttributionUnmappedPanel />
<BookingLinkMatrix
  teams={teams}
  closers={closers}
  eventTypeConfigs={eventTypeConfigs}
/>
```

**Key implementation notes:**
- Use React Hook Form + Zod if the dialog grows past simple state; the repo standard is `standardSchemaResolver` with `zod`.
- Do not expose raw UTM values to PostHog.
- The unmapped panel may display raw UTM values to tenant admins inside the app, but those values must never be sent to analytics.
- The booking matrix should show every active event type, its booked-program mapping status, active DM teams, and active DM closers so missing URL pieces are visible before links are used.
- Use tables and compact cards; this is workspace configuration, not marketing UI.
- `TabsTrigger` stays inside `TabsList`, and dialogs must include titles/descriptions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/operations/unmappedUtms.ts` | Create | Recent unmapped UTM query |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | Add Attribution tab |
| `app/workspace/settings/_components/attribution-tab.tsx` | Create | Registry management |
| `app/workspace/settings/_components/attribution-unmapped-panel.tsx` | Create | Recent unmapped UTM queue |
| `app/workspace/settings/_components/booking-link-matrix.tsx` | Create | Event type + DM team/closer matrix |
| `app/workspace/settings/_components/attribution-team-dialog.tsx` | Create | Team CRUD dialog |
| `app/workspace/settings/_components/dm-closer-dialog.tsx` | Create | DM closer CRUD dialog |
| `app/workspace/settings/_components/attribution-alias-dialog.tsx` | Create | Alias CRUD dialog |
| `app/workspace/settings/_components/event-type-config-dialog.tsx` | Modify | Booked-program controls |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | Mapping status display |

---

### 2E — Pipeline and Sold-Program Dual Write

**Type:** Backend
**Parallelizable:** No — depends on resolver and booked-program API from 2B and 2C.

**What:** Patch `invitee.created` and payment/customer conversion paths to populate resolved attribution, booked-program caches, first-booking fields, and sold-program caches.

**Why:** Operations list queries should read precomputed cache fields instead of joining registry/config/payment data on every row.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/customers/conversion.ts` (modify)
- `convex/closer/payments.ts` (modify)
- `convex/closer/reminderOutcomes.ts` (modify)
- `convex/sideDeals/logPayment.ts` (modify)
- `convex/sideDeals/voidPayment.ts` (modify)
- `convex/lib/soldProgramCache.ts` (new)

**How:**

**Step 1: Resolve attribution once per booking.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
import { clampUtmValue } from "../lib/attribution/normalize";
import {
  isInternalUtm,
  resolveAttributionForTenant,
} from "../lib/attribution/resolveAttribution";

const rawUtmParams = extractUtmParams(payload.tracking);
const clampedSource = clampUtmValue(rawUtmParams?.utm_source);
const clampedMedium = clampUtmValue(rawUtmParams?.utm_medium);
const utmParams = rawUtmParams
  ? {
      ...rawUtmParams,
      utm_source: clampedSource.value,
      utm_medium: clampedMedium.value,
    }
  : undefined;
const utmTruncated = clampedSource.truncated || clampedMedium.truncated;
const resolvedAttribution = await resolveAttributionForTenant(ctx, {
  tenantId,
  utmParams,
});
```

**Step 2: Build booked-program patch from event type config.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
function bookedProgramPatch(config: Doc<"eventTypeConfigs"> | null | undefined) {
  return {
    bookingProgramId: config?.bookingProgramId,
    bookingProgramName: config?.bookingProgramName,
    bookingProgramMappingStatus:
      config?.bookingProgramMappingStatus ?? ("unmapped" as const),
  };
}

function attributionPatch(resolved: ResolvedAttribution) {
  return {
    attributionTeamId: resolved.teamId,
    dmCloserId: resolved.dmCloserId,
    attributionAliasId: resolved.aliasId,
    attributionResolution: resolved.resolutionStatus,
    attributionResolvedAt: resolved.resolvedAt,
    attributionResolutionVersion: resolved.resolutionVersion,
  };
}
```

**Step 3: Include meeting-level fields on every inserted meeting.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
const effectiveEventTypeConfig = meetingEventTypeConfigId
  ? await ctx.db.get(meetingEventTypeConfigId)
  : null;

const meetingId = await ctx.db.insert("meetings", {
  tenantId,
  opportunityId,
  assignedCloserId: meetingAssignedCloserId,
  calendlyEventUri,
  calendlyInviteeUri,
  scheduledAt,
  durationMinutes,
  status: "scheduled",
  leadName: lead.fullName ?? lead.email,
  createdAt: now,
  utmParams,
  utmTruncated,
  ...bookedProgramPatch(effectiveEventTypeConfig),
  ...attributionPatch(resolvedAttribution),
});
```

**Step 4: Patch opportunity first external booking fields only once.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
const isExternalFirstBooking =
  !isInternalUtm(utmParams) &&
  opportunity.firstMeetingId === undefined &&
  opportunity.firstBookedAt === undefined;

if (isExternalFirstBooking) {
  await ctx.db.patch(opportunityId, {
    utmParams,
    firstBookedAt: now,
    firstMeetingId: meetingId,
    firstMeetingAt: scheduledAt,
    firstBookingProgramId: effectiveEventTypeConfig?.bookingProgramId,
    firstBookingProgramName: effectiveEventTypeConfig?.bookingProgramName,
    firstBookingProgramMappingStatus:
      effectiveEventTypeConfig?.bookingProgramMappingStatus ?? "unmapped",
    ...attributionPatch(resolvedAttribution),
  });
}
```

**Step 5: Centralize sold-program cache refresh.**

```typescript
// Path: convex/lib/soldProgramCache.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function refreshSoldProgramCachesForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) return;

  const payment = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .order("desc")
    .first();

  const soldProgramPatch = payment
    ? {
        soldProgramId: payment.programId,
        soldProgramName: payment.programName,
      }
    : {
        soldProgramId: undefined,
        soldProgramName: undefined,
      };

  await ctx.db.patch(opportunityId, soldProgramPatch);

  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(50);
  await Promise.all(
    meetings.map((meeting: Doc<"meetings">) =>
      ctx.db.patch(meeting._id, soldProgramPatch),
    ),
  );
}
```

**Key implementation notes:**
- Apply the meeting insert change to all insert branches in `inviteeCreated.ts`, including deterministic UTM relinks and heuristic reschedules.
- Do not overwrite opportunity-level first-touch UTM or first-booked-program fields on follow-up/reschedule bookings.
- Refresh Operations projections in Phase 3 after each cache-changing write.
- Sold program comes from payments/customers only; booked program never implies sold program.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Attribution and booked-program dual-write |
| `convex/lib/soldProgramCache.ts` | Create | Sold-program cache helper |
| `convex/customers/conversion.ts` | Modify | Refresh sold-program cache |
| `convex/closer/payments.ts` | Modify | Refresh sold-program cache after payment |
| `convex/closer/reminderOutcomes.ts` | Modify | Refresh sold-program cache after reminder payment |
| `convex/sideDeals/logPayment.ts` | Modify | Refresh sold-program cache after side-deal payment |
| `convex/sideDeals/voidPayment.ts` | Modify | Clear/recompute cache after void |

---

### 2F — Backfills and Production Verification

**Type:** Backend / Manual
**Parallelizable:** No — runs after 2E is deployed and dual-writing new traffic.

**What:** Define resumable migrations for existing event types, meetings, opportunities, attribution resolution, first-booking fields, and sold-program caches.

**Why:** Existing production rows need cache fields before Operations filters and reports can be trusted.

**Where:**
- `convex/migrations.ts` (modify)
- `convex/admin/migrations.ts` (optional admin orchestration)
- `convex/operations/projections.ts` (Phase 3 dependency, referenced but not required yet)

**How:**

**Step 1: Add dry-run-friendly migrations.**

```typescript
// Path: convex/migrations.ts
import {
  isInternalUtm,
  resolveAttributionForTenant,
} from "./lib/attribution/resolveAttribution";
import { refreshSoldProgramCachesForOpportunity } from "./lib/soldProgramCache";

export const backfillAttributionResolutionOnMeetings = migrations.define({
  table: "meetings",
  batchSize: 100,
  migrateOne: async (ctx, meeting) => {
    const resolved = await resolveAttributionForTenant(ctx, {
      tenantId: meeting.tenantId,
      utmParams: meeting.utmParams,
    });
    await ctx.db.patch(meeting._id, {
      attributionTeamId: resolved.teamId,
      dmCloserId: resolved.dmCloserId,
      attributionAliasId: resolved.aliasId,
      attributionResolution: resolved.resolutionStatus,
      attributionResolvedAt: resolved.resolvedAt,
      attributionResolutionVersion: resolved.resolutionVersion,
    });
  },
});

export const backfillSoldProgramCaches = migrations.define({
  table: "opportunities",
  batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    await refreshSoldProgramCachesForOpportunity(ctx, opportunity._id);
  },
});
```

**Step 2: Backfill opportunity first-booking fields from earliest external meeting.**

```typescript
// Path: convex/migrations.ts
export const backfillOpportunityFirstBookingFields = migrations.define({
  table: "opportunities",
  batchSize: 50,
  migrateOne: async (ctx, opportunity) => {
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )
      .take(20);

    const firstExternal = meetings.find(
      (meeting) => !isInternalUtm(meeting.utmParams),
    );
    if (!firstExternal) return;

    await ctx.db.patch(opportunity._id, {
      firstBookedAt: firstExternal.createdAt,
      firstMeetingId: firstExternal._id,
      firstMeetingAt: firstExternal.scheduledAt,
      firstBookingProgramId: firstExternal.bookingProgramId,
      firstBookingProgramName: firstExternal.bookingProgramName,
      firstBookingProgramMappingStatus: firstExternal.bookingProgramMappingStatus,
      attributionTeamId: firstExternal.attributionTeamId,
      dmCloserId: firstExternal.dmCloserId,
      attributionAliasId: firstExternal.attributionAliasId,
      attributionResolution: firstExternal.attributionResolution,
      attributionResolvedAt: firstExternal.attributionResolvedAt,
      attributionResolutionVersion: firstExternal.attributionResolutionVersion,
    });
  },
});
```

**Step 3: Run dry runs and monitored batches.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex run migrations:run '{"fn":"backfillAttributionResolutionOnMeetings","dryRun":true}'
npx convex run migrations:run '{"fn":"backfillOpportunityFirstBookingFields","dryRun":true}'
npx convex run migrations:run '{"fn":"backfillSoldProgramCaches","dryRun":true}'
```

**Step 4: Verify production counts before enabling UI filters.**

```typescript
// Path: convex/admin/migrations.ts
const ATTRIBUTION_READINESS_TENANT_LIMIT = 50;
const ATTRIBUTION_READINESS_SAMPLE_LIMIT = 250;

export const getAttributionBackfillReadiness = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);

    const tenants = await ctx.db
      .query("tenants")
      .order("desc")
      .take(ATTRIBUTION_READINESS_TENANT_LIMIT);

    const tenantSummaries = await Promise.all(
      tenants.map(async (tenant) => {
        const meetings = await ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_scheduledAt", (q) =>
            q.eq("tenantId", tenant._id),
          )
          .order("desc")
          .take(ATTRIBUTION_READINESS_SAMPLE_LIMIT);

        const opportunities = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_latestActivityAt", (q) =>
            q.eq("tenantId", tenant._id),
          )
          .order("desc")
          .take(ATTRIBUTION_READINESS_SAMPLE_LIMIT);

        const eventTypes = await ctx.db
          .query("eventTypeConfigs")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
          .take(ATTRIBUTION_READINESS_SAMPLE_LIMIT);

        return {
          tenantId: tenant._id,
          meetings: {
            sampled: meetings.length,
            withUtm: meetings.filter((meeting) => meeting.utmParams).length,
            resolved: meetings.filter((meeting) => meeting.attributionResolution)
              .length,
            unmapped: meetings.filter(
              (meeting) => meeting.attributionResolution === "unmapped",
            ).length,
            internal: meetings.filter(
              (meeting) => meeting.attributionResolution === "internal",
            ).length,
          },
          opportunities: {
            sampled: opportunities.length,
            withFirstBooking: opportunities.filter(
              (opportunity) => opportunity.firstMeetingId || opportunity.firstBookedAt,
            ).length,
            withSoldProgram: opportunities.filter(
              (opportunity) => opportunity.soldProgramId,
            ).length,
          },
          eventTypes: {
            sampled: eventTypes.length,
            mapped: eventTypes.filter((eventType) => eventType.bookingProgramId)
              .length,
            unmapped: eventTypes.filter((eventType) => !eventType.bookingProgramId)
              .length,
          },
          truncated:
            meetings.length === ATTRIBUTION_READINESS_SAMPLE_LIMIT ||
            opportunities.length === ATTRIBUTION_READINESS_SAMPLE_LIMIT ||
            eventTypes.length === ATTRIBUTION_READINESS_SAMPLE_LIMIT,
        };
      }),
    );

    return {
      tenantCount: tenants.length,
      tenantSummaries,
      truncatedTenants: tenants.length === ATTRIBUTION_READINESS_TENANT_LIMIT,
    };
  },
});
```

**Key implementation notes:**
- Backfills recompute cache fields only. They must never rewrite `utmParams`.
- Use `by_opportunityId` default creation order for first-booking backfill; `by_opportunityId_and_scheduledAt` can choose the earliest scheduled meeting rather than the first booking CRM processed.
- Run with `dryRun: true` first and retain migration status output.
- Rebuild `operationsQualificationRows` after Phase 3 projection helpers exist.
- Rollback UI by hiding nav/tabs if needed; do not roll back schema fields while dual-write is active.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations.ts` | Modify | Resumable backfills |
| `convex/admin/migrations.ts` | Modify | Readiness/audit helper |
| `convex/operations/projections.ts` | Reuse / Phase 3 | Projection rebuild hook after it exists |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/attribution/validators.ts` | Create | 2A |
| `convex/schema.ts` | Modify | 2A |
| `convex/lib/attribution/normalize.ts` | Create | 2B |
| `convex/lib/attribution/resolveAttribution.ts` | Create | 2B |
| `convex/attribution/teams.ts` | Create | 2B |
| `convex/attribution/dmClosers.ts` | Create | 2B |
| `convex/attribution/aliases.ts` | Create | 2B |
| `convex/eventTypeConfigs/mutations.ts` | Modify | 2C |
| `convex/eventTypeConfigs/queries.ts` | Modify | 2C |
| `convex/pipeline/inviteeCreated.ts` | Modify | 2C, 2E |
| `convex/operations/unmappedUtms.ts` | Create | 2D |
| `app/workspace/settings/_components/settings-page-client.tsx` | Modify | 2D |
| `app/workspace/settings/_components/attribution-tab.tsx` | Create | 2D |
| `app/workspace/settings/_components/attribution-unmapped-panel.tsx` | Create | 2D |
| `app/workspace/settings/_components/booking-link-matrix.tsx` | Create | 2D |
| `app/workspace/settings/_components/attribution-team-dialog.tsx` | Create | 2D |
| `app/workspace/settings/_components/dm-closer-dialog.tsx` | Create | 2D |
| `app/workspace/settings/_components/attribution-alias-dialog.tsx` | Create | 2D |
| `app/workspace/settings/_components/event-type-config-dialog.tsx` | Modify | 2D |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modify | 2D |
| `convex/lib/soldProgramCache.ts` | Create | 2E |
| `convex/customers/conversion.ts` | Modify | 2E |
| `convex/closer/payments.ts` | Modify | 2E |
| `convex/closer/reminderOutcomes.ts` | Modify | 2E |
| `convex/sideDeals/logPayment.ts` | Modify | 2E |
| `convex/sideDeals/voidPayment.ts` | Modify | 2E |
| `convex/migrations.ts` | Modify | 2F |
| `convex/admin/migrations.ts` | Modify | 2F |
