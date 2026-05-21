# Phase 3 — Operations Hub: Qualification

**Goal:** Build the row-level Qualification tab from a durable Slack qualification ledger and projection table so every accepted `/qualify` attempt appears, including duplicates and already-booked leads.

**Prerequisite:** Phase 1 route shell exists. Phase 2 schema/resolver work is deployed or, at minimum, attribution/program fields are available as optional fields. Read `convex/_generated/ai/guidelines.md`, `.docs/convex/database/indexes-and-query-performance.md`, and `.docs/convex/database/paginated-queries.md`.

**Runs in PARALLEL with:** Phase 4 after subphase 3A creates `operationsQualificationRows`. Phase 5 depends on the ledger/projection contract for detail attribution.

**Skills to invoke:**
- `convex-migration-helper` — Add new ledger/projection tables, dual-write from Slack, and backfill existing Slack-sourced opportunities.
- `convex-performance-audit` — Qualification list/search filters must use projection indexes/search indexes, not opportunity scans.
- `frontend-design` — The Qualification tab is an operational queue with dense filters and rows.
- `shadcn` — Use Tabs, Table, Select, ToggleGroup, Empty, Skeleton, Alert, Badge, and Button primitives.
- `vercel-react-best-practices` — Use `usePaginatedQuery`, stable query args, and avoid client-side filter scans.

**Acceptance Criteria:**
1. Every accepted Slack qualification submission inserts one `slackQualificationEvents` row, even when the opportunity is deduped or already booked.
2. Every qualification event has one `operationsQualificationRows` projection row unless repair is required.
3. `createQualifiedLead` returns the same API shape expected by Slack callers while additionally writing the ledger/projection.
4. `/workspace/operations?tab=qualifications` renders a paginated table for tenant admins/owners.
5. Qualification filters include status, booked program, sold program, Slack qualifier, DM team, DM closer, period, and search, with one indexed primary dimension plus period enabled at a time.
6. Rows with `resultKind: "unlinked"` render with an operational warning and no broken detail link.
7. Slack Qualifications report includes a link to the Operations Qualification tab using the current date range where practical.
8. Backfill creates ledger/projection rows for existing `source: "slack_qualified"` opportunities.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (ledger + projection schema) ───────────┬── 3B (projection helper)
                                           └── 3C (Slack dual-write)

3B + 3C complete ─────────────────────────── 3D (qualification queries)

3D complete ───────────────┬──────────────── 3E (Qualification tab UI)
                            └──────────────── 3F (report cross-link)

3C + 3D complete ─────────────────────────── 3G (backfill + verification)
```

**Optimal execution:**
1. Complete 3A first and regenerate Convex types.
2. Implement projection helper and Slack dual-write together.
3. Build list/search/filter queries against the projection table.
4. Replace the Phase 1 placeholder tab with the real Qualification tab.
5. Add report cross-link and run backfill/verification.

**Estimated time:** 3-5 days

---

## Subphases

### 3A — Qualification Ledger and Projection Schema

**Type:** Backend
**Parallelizable:** No — all other Phase 3 code imports these tables.

**What:** Add `slackQualificationEvents` and `operationsQualificationRows` to `convex/schema.ts`.

**Why:** Operations cannot use `opportunities.source` alone because duplicate/already-booked Slack qualification attempts may not create a new opportunity.

**Where:**
- `convex/schema.ts` (modify)
- `convex/operations/validators.ts` (new)

**How:**

**Step 1: Add result-kind validators.**

```typescript
// Path: convex/operations/validators.ts
import { v } from "convex/values";
import { opportunityStatusValidator } from "../opportunities/validators";

export const slackQualificationResultKindValidator = v.union(
  v.literal("created_opportunity"),
  v.literal("duplicate_pending"),
  v.literal("already_booked"),
  v.literal("unlinked"),
);

export const operationsQualificationStatusFilterValidator = v.optional(
  opportunityStatusValidator,
);
```

**Step 2: Add the durable ledger.**

```typescript
// Path: convex/schema.ts
import { slackQualificationResultKindValidator } from "./operations/validators";

slackQualificationEvents: defineTable({
  tenantId: v.id("tenants"),
  installationId: v.id("slackInstallations"),
  leadId: v.optional(v.id("leads")),
  opportunityId: v.optional(v.id("opportunities")),
  resultKind: slackQualificationResultKindValidator,
  qualifiedBy: v.object({
    slackUserId: v.string(),
    slackTeamId: v.string(),
    submittedAt: v.number(),
  }),
  slackUserId: v.string(),
  slackTeamId: v.string(),
  fullNameSnapshot: v.string(),
  platform: socialPlatformValidator,
  handleSnapshot: v.string(),
  submittedAt: v.number(),
  createdAt: v.number(),
})
  .index("by_tenantId_and_submittedAt", ["tenantId", "submittedAt"])
  .index("by_tenantId_and_slackUserId_and_submittedAt", [
    "tenantId",
    "slackUserId",
    "submittedAt",
  ])
  .index("by_tenantId_and_opportunityId", ["tenantId", "opportunityId"])
  .index("by_tenantId_and_leadId_and_submittedAt", [
    "tenantId",
    "leadId",
    "submittedAt",
  ]),
```

**Step 3: Add the Operations projection table.**

```typescript
// Path: convex/schema.ts
operationsQualificationRows: defineTable({
  tenantId: v.id("tenants"),
  qualificationEventId: v.id("slackQualificationEvents"),
  opportunityId: v.optional(v.id("opportunities")),
  leadId: v.optional(v.id("leads")),
  slackUserId: v.string(),
  slackTeamId: v.string(),
  resultKind: slackQualificationResultKindValidator,
  opportunityStatus: v.optional(opportunityStatusValidator),
  bookingProgramId: v.optional(v.id("tenantPrograms")),
  bookingProgramName: v.optional(v.string()),
  bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
  soldProgramId: v.optional(v.id("tenantPrograms")),
  soldProgramName: v.optional(v.string()),
  qualifiedAt: v.number(),
  firstBookedAt: v.optional(v.number()),
  firstMeetingId: v.optional(v.id("meetings")),
  firstMeetingAt: v.optional(v.number()),
  assignedCloserId: v.optional(v.id("users")),
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  attributionResolution: attributionResolutionValidator,
  searchText: v.string(),
  updatedAt: v.number(),
})
  .index("by_qualificationEventId", ["qualificationEventId"])
  .index("by_tenantId_and_qualifiedAt", ["tenantId", "qualifiedAt"])
  .index("by_tenantId_and_opportunityStatus_and_qualifiedAt", [
    "tenantId",
    "opportunityStatus",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_bookingProgramId_and_qualifiedAt", [
    "tenantId",
    "bookingProgramId",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_soldProgramId_and_qualifiedAt", [
    "tenantId",
    "soldProgramId",
    "qualifiedAt",
  ])
  .index("by_tenantId_and_slackUserId_and_qualifiedAt", [
    "tenantId",
    "slackUserId",
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
  .index("by_tenantId_and_firstMeetingAt", ["tenantId", "firstMeetingAt"])
  .index("by_tenantId_and_bookingProgramId_and_firstMeetingAt", [
    "tenantId",
    "bookingProgramId",
    "firstMeetingAt",
  ])
  .index("by_tenantId_and_soldProgramId_and_firstMeetingAt", [
    "tenantId",
    "soldProgramId",
    "firstMeetingAt",
  ])
  .index("by_tenantId_and_slackUserId_and_firstMeetingAt", [
    "tenantId",
    "slackUserId",
    "firstMeetingAt",
  ])
  .index("by_tenantId_and_assignedCloserId_and_firstMeetingAt", [
    "tenantId",
    "assignedCloserId",
    "firstMeetingAt",
  ])
  .index("by_tenantId_and_attributionTeamId_and_firstMeetingAt", [
    "tenantId",
    "attributionTeamId",
    "firstMeetingAt",
  ])
  .index("by_tenantId_and_dmCloserId_and_firstMeetingAt", [
    "tenantId",
    "dmCloserId",
    "firstMeetingAt",
  ])
  .searchIndex("search_qualification_rows", {
    searchField: "searchText",
    filterFields: [
      "tenantId",
      "opportunityStatus",
      "bookingProgramId",
      "soldProgramId",
      "slackUserId",
      "attributionTeamId",
      "dmCloserId",
    ],
  }),
```

**Key implementation notes:**
- Add the `by_qualificationEventId` index even though it is not in the design sketch; projection upsert needs an efficient unique lookup.
- `attributionResolution` is required on the projection because the projection is newly created and every builder can write `"none"` if no attribution exists.
- The `firstMeetingAt` indexes are for Phase 4 Scheduling filters. Add them with the projection table so Phase 4 does not require another schema-only deploy.
- Do not include lead PII beyond normalized row display/search fields needed for Operations.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/operations/validators.ts` | Create | Result-kind and filter validators |
| `convex/schema.ts` | Modify | Ledger and projection tables |

---

### 3B — Projection Builder

**Type:** Backend
**Parallelizable:** Yes — depends on 3A.

**What:** Create an idempotent helper that rebuilds one qualification projection row from the ledger, linked opportunity, lead, and first booking caches.

**Why:** The row must refresh when Slack events are created, opportunity status changes, first booking fields change, sold program caches change, and attribution backfills run.

**Where:**
- `convex/operations/projections.ts` (new)
- `convex/lib/leadDisplay.ts` (reuse)

**How:**

**Step 1: Build row search text and labels.**

```typescript
// Path: convex/operations/projections.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

function buildQualificationSearchText(args: {
  event: Doc<"slackQualificationEvents">;
  lead: Doc<"leads"> | null;
  opportunity: Doc<"opportunities"> | null;
}) {
  return [
    args.event.fullNameSnapshot,
    args.event.handleSnapshot,
    args.event.slackUserId,
    args.lead?.fullName,
    args.lead?.email,
    args.lead?.phone,
    args.opportunity?.status,
    args.opportunity?.firstBookingProgramName,
    args.opportunity?.soldProgramName,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}
```

**Step 2: Implement idempotent upsert.**

```typescript
// Path: convex/operations/projections.ts
export async function rebuildQualificationRow(
  ctx: MutationCtx,
  qualificationEventId: Id<"slackQualificationEvents">,
) {
  const event = await ctx.db.get(qualificationEventId);
  if (!event) return;

  const [lead, opportunity] = await Promise.all([
    event.leadId ? ctx.db.get(event.leadId) : Promise.resolve(null),
    event.opportunityId ? ctx.db.get(event.opportunityId) : Promise.resolve(null),
  ]);

  const row = {
    tenantId: event.tenantId,
    qualificationEventId: event._id,
    opportunityId: opportunity?._id,
    leadId: lead?._id ?? event.leadId,
    slackUserId: event.slackUserId,
    slackTeamId: event.slackTeamId,
    resultKind: event.resultKind,
    opportunityStatus: opportunity?.status,
    bookingProgramId: opportunity?.firstBookingProgramId,
    bookingProgramName: opportunity?.firstBookingProgramName,
    bookingProgramMappingStatus: opportunity?.firstBookingProgramMappingStatus,
    soldProgramId: opportunity?.soldProgramId,
    soldProgramName: opportunity?.soldProgramName,
    qualifiedAt: event.submittedAt,
    firstBookedAt: opportunity?.firstBookedAt,
    firstMeetingId: opportunity?.firstMeetingId,
    firstMeetingAt: opportunity?.firstMeetingAt,
    assignedCloserId: opportunity?.assignedCloserId,
    attributionTeamId: opportunity?.attributionTeamId,
    dmCloserId: opportunity?.dmCloserId,
    attributionResolution: opportunity?.attributionResolution ?? "none",
    searchText: buildQualificationSearchText({ event, lead, opportunity }),
    updatedAt: Date.now(),
  };

  const existing = await ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_qualificationEventId", (q) =>
      q.eq("qualificationEventId", qualificationEventId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, row);
    return existing._id;
  }
  return await ctx.db.insert("operationsQualificationRows", row);
}
```

**Step 3: Add opportunity-level rebuild helper.**

```typescript
// Path: convex/operations/projections.ts
export async function rebuildQualificationRowsForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) return;

  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_opportunityId", (q) =>
      q.eq("tenantId", opportunity.tenantId).eq("opportunityId", opportunityId),
    )
    .take(50);

  await Promise.all(events.map((event) => rebuildQualificationRow(ctx, event._id)));
}
```

**Key implementation notes:**
- Keep projection rebuild in mutation helpers, not queries.
- Call this helper from Slack create, pipeline first-booking patch, payment cache refresh, and attribution backfill.
- Do not use `.filter()` or unbounded `.collect()` to find events.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/operations/projections.ts` | Create | Idempotent projection builder |

---

### 3C — Slack Qualification Dual Write

**Type:** Backend
**Parallelizable:** Yes — depends on 3A and 3B.

**What:** Patch `convex/slack/createQualifiedLead.ts` so every accepted submission inserts a ledger row and rebuilds the Operations projection before returning.

**Why:** Duplicate and already-booked Slack submissions are operationally important and currently disappear if no opportunity is inserted.

**Where:**
- `convex/slack/createQualifiedLead.ts` (modify)

**How:**

**Step 1: Add a local event insertion helper.**

```typescript
// Path: convex/slack/createQualifiedLead.ts
import { rebuildQualificationRow } from "../operations/projections";

async function insertQualificationEvent(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    installationId: Id<"slackInstallations">;
    leadId?: Id<"leads">;
    opportunityId?: Id<"opportunities">;
    resultKind: "created_opportunity" | "duplicate_pending" | "already_booked" | "unlinked";
    fullName: string;
    platform: Doc<"leadIdentifiers">["type"];
    handle: string;
    qualifiedBy: {
      slackUserId: string;
      slackTeamId: string;
      submittedAt: number;
    };
    now: number;
  },
) {
  const eventId = await ctx.db.insert("slackQualificationEvents", {
    tenantId: args.tenantId,
    installationId: args.installationId,
    leadId: args.leadId,
    opportunityId: args.opportunityId,
    resultKind: args.resultKind,
    qualifiedBy: args.qualifiedBy,
    slackUserId: args.qualifiedBy.slackUserId,
    slackTeamId: args.qualifiedBy.slackTeamId,
    fullNameSnapshot: args.fullName.trim(),
    platform: args.platform,
    handleSnapshot: args.handle.trim(),
    submittedAt: args.qualifiedBy.submittedAt,
    createdAt: args.now,
  });
  await rebuildQualificationRow(ctx, eventId);
  return eventId;
}
```

**Step 2: Insert events in duplicate branches before returning.**

```typescript
// Path: convex/slack/createQualifiedLead.ts
if (recent) {
  await insertQualificationEvent(ctx, {
    tenantId: args.tenantId,
    installationId: args.installationId,
    leadId: resolution.leadId,
    opportunityId: recent._id,
    resultKind: "duplicate_pending",
    fullName: args.fullName,
    platform: args.platform,
    handle: args.handle,
    qualifiedBy: args.qualifiedBy,
    now,
  });

  return {
    duplicate: true as const,
    existingOpportunityId: recent._id,
    priorQualifiedBy: recent.qualifiedBy ?? null,
  };
}

if (alreadyBooked) {
  await insertQualificationEvent(ctx, {
    tenantId: args.tenantId,
    installationId: args.installationId,
    leadId: resolution.leadId,
    opportunityId: alreadyBooked._id,
    resultKind:
      alreadyBooked.status === "qualified_pending"
        ? "duplicate_pending"
        : "already_booked",
    fullName: args.fullName,
    platform: args.platform,
    handle: args.handle,
    qualifiedBy: args.qualifiedBy,
    now,
  });

  return {
    duplicate: true as const,
    existingOpportunityId: alreadyBooked._id,
    priorQualifiedBy: alreadyBooked.qualifiedBy ?? null,
    alreadyBooked: alreadyBooked.status !== "qualified_pending",
  };
}
```

**Step 3: Insert event after creating a new opportunity.**

```typescript
// Path: convex/slack/createQualifiedLead.ts
const opportunityId = await ctx.db.insert("opportunities", {
  tenantId: args.tenantId,
  leadId: resolution.leadId,
  status: "qualified_pending",
  source: "slack_qualified",
  qualifiedBy: args.qualifiedBy,
  qualifiedAt: args.qualifiedBy.submittedAt,
  createdAt: now,
  updatedAt: now,
  latestActivityAt: now,
});

await insertQualificationEvent(ctx, {
  tenantId: args.tenantId,
  installationId: args.installationId,
  leadId: resolution.leadId,
  opportunityId,
  resultKind: "created_opportunity",
  fullName: args.fullName,
  platform: args.platform,
  handle: args.handle,
  qualifiedBy: args.qualifiedBy,
  now,
});
```

**Key implementation notes:**
- Keep the external return shape stable for Slack command handlers.
- Add `qualifiedAt` to new opportunities here; backfill legacy rows in 3G.
- If lead identity resolution fails after Slack accepted the command, consider inserting `resultKind: "unlinked"` in a future repair path. Do not invent that path unless the existing command flow can recover safely.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/createQualifiedLead.ts` | Modify | Ledger and projection dual-write |

---

### 3D — Qualification Queries

**Type:** Backend
**Parallelizable:** No — depends on projection rows from 3B/3C.

**What:** Add paginated qualification list, search, and filter-option queries under `convex/operations/qualifications.ts`.

**Why:** The UI needs reactive, bounded, index-backed data that does not scan opportunities or join multiple tables per filter change.

**Where:**
- `convex/operations/qualifications.ts` (new)

**How:**

**Step 1: Build a narrow indexed query selector.**

```typescript
// Path: convex/operations/qualifications.ts
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { opportunityStatusValidator } from "../opportunities/validators";
import { requireTenantUser } from "../requireTenantUser";

function qualificationRowsQuery(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    statusFilter?: Doc<"opportunities">["status"];
    bookingProgramId?: Id<"tenantPrograms">;
    soldProgramId?: Id<"tenantPrograms">;
    slackUserId?: string;
    attributionTeamId?: Id<"attributionTeams">;
    dmCloserId?: Id<"dmClosers">;
    qualifiedAfter?: number;
    qualifiedBefore?: number;
  },
) {
  const primaryFilters = [
    args.statusFilter,
    args.bookingProgramId,
    args.soldProgramId,
    args.slackUserId,
    args.attributionTeamId,
    args.dmCloserId,
  ].filter(Boolean).length;
  if (primaryFilters > 1) {
    throw new Error("Select only one primary qualification filter at a time.");
  }

  if (args.statusFilter) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_opportunityStatus_and_qualifiedAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("opportunityStatus", args.statusFilter);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore !== undefined
          ? ranged.lt("qualifiedAt", args.qualifiedBefore)
          : ranged;
      },
    );
  }
  if (args.bookingProgramId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_bookingProgramId_and_qualifiedAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("bookingProgramId", args.bookingProgramId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore !== undefined
          ? ranged.lt("qualifiedAt", args.qualifiedBefore)
          : ranged;
      },
    );
  }
  if (args.soldProgramId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_soldProgramId_and_qualifiedAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("soldProgramId", args.soldProgramId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore !== undefined
          ? ranged.lt("qualifiedAt", args.qualifiedBefore)
          : ranged;
      },
    );
  }
  if (args.slackUserId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_slackUserId_and_qualifiedAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("slackUserId", args.slackUserId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore !== undefined
          ? ranged.lt("qualifiedAt", args.qualifiedBefore)
          : ranged;
      },
    );
  }
  if (args.attributionTeamId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_attributionTeamId_and_qualifiedAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("attributionTeamId", args.attributionTeamId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore !== undefined
          ? ranged.lt("qualifiedAt", args.qualifiedBefore)
          : ranged;
      },
    );
  }
  if (args.dmCloserId) {
    return ctx.db.query("operationsQualificationRows").withIndex(
      "by_tenantId_and_dmCloserId_and_qualifiedAt",
      (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("dmCloserId", args.dmCloserId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore !== undefined
          ? ranged.lt("qualifiedAt", args.qualifiedBefore)
          : ranged;
      },
    );
  }
  return ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_tenantId_and_qualifiedAt", (q) => {
      const base = q.eq("tenantId", args.tenantId);
      const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
      return args.qualifiedBefore !== undefined
        ? ranged.lt("qualifiedAt", args.qualifiedBefore)
        : ranged;
    });
}
```

**Step 2: Add paginated list query.**

```typescript
// Path: convex/operations/qualifications.ts
export const listQualificationQueue = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
    qualifiedAfter: v.optional(v.number()),
    qualifiedBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await qualificationRowsQuery(ctx, {
      tenantId,
      statusFilter: args.statusFilter,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      slackUserId: args.slackUserId,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
      qualifiedAfter: args.qualifiedAfter,
      qualifiedBefore: args.qualifiedBefore,
    })
      .order("desc")
      .paginate(args.paginationOpts);
    return result;
  },
});
```

**Step 3: Add search query.**

```typescript
// Path: convex/operations/qualifications.ts
export const searchQualificationQueue = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(opportunityStatusValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const term = args.searchTerm.trim();
    if (term.length < 2) return [];

    return await ctx.db
      .query("operationsQualificationRows")
      .withSearchIndex("search_qualification_rows", (q) => {
        let search = q.search("searchText", term).eq("tenantId", tenantId);
        if (args.statusFilter) search = search.eq("opportunityStatus", args.statusFilter);
        if (args.bookingProgramId) search = search.eq("bookingProgramId", args.bookingProgramId);
        if (args.soldProgramId) search = search.eq("soldProgramId", args.soldProgramId);
        if (args.slackUserId) search = search.eq("slackUserId", args.slackUserId);
        if (args.attributionTeamId) search = search.eq("attributionTeamId", args.attributionTeamId);
        if (args.dmCloserId) search = search.eq("dmCloserId", args.dmCloserId);
        return search;
      })
      .take(50);
  },
});
```

**Key implementation notes:**
- Prefer one primary indexed narrowing filter per query. Do not silently ignore extra filters; disable unsupported combinations in the UI or reject them in the query.
- Date filtering must be part of the selected `qualifiedAt` index branch before pagination.
- Use `.paginate()` for list and `.take(50)` for search.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/operations/qualifications.ts` | Create | List/search queries |

---

### 3E — Qualification Tab UI

**Type:** Frontend
**Parallelizable:** No — depends on 3D query contracts.

**What:** Replace the Phase 1 Qualification placeholder with filters, search, stats strip, table rows, row links, and unlinked warnings.

**Why:** Admins need row-level visibility into Slack-qualified leads, not only aggregate Slack reports.

**Where:**
- `app/workspace/operations/_components/operations-page-client.tsx` (modify)
- `app/workspace/operations/_components/qualification-tab.tsx` (new)
- `app/workspace/operations/_components/qualification-filters.tsx` (new)
- `app/workspace/operations/_components/qualification-table.tsx` (new)
- `app/workspace/operations/_components/qualification-repair-sheet.tsx` (new)
- `app/workspace/operations/_components/operations-period.ts` (new)

**How:**

**Step 1: Render the real tab component.**

```tsx
// Path: app/workspace/operations/_components/operations-page-client.tsx
import { QualificationTab } from "./qualification-tab";

<TabsContent value="qualifications" className="mt-6">
  <QualificationTab />
</TabsContent>
```

**Step 2: Query paginated rows with stable args.**

```tsx
// Path: app/workspace/operations/_components/qualification-tab.tsx
"use client";

import { useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { QualificationFilters } from "./qualification-filters";
import { QualificationRepairSheet } from "./qualification-repair-sheet";
import { QualificationTable, type QualificationRow } from "./qualification-table";

export function QualificationTab() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [bookingProgramId, setBookingProgramId] = useState<Id<"tenantPrograms"> | "all">("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [repairRow, setRepairRow] = useState<QualificationRow | null>(null);

  const queryArgs = useMemo(
    () => ({
      statusFilter: statusFilter === "all" ? undefined : statusFilter,
      bookingProgramId: bookingProgramId === "all" ? undefined : bookingProgramId,
    }),
    [bookingProgramId, statusFilter],
  );

  const trimmed = searchTerm.trim();
  const isSearching = trimmed.length >= 2;
  const paginated = usePaginatedQuery(
    api.operations.qualifications.listQualificationQueue,
    isSearching ? "skip" : queryArgs,
    { initialNumItems: 25 },
  );
  const searchResults = useQuery(
    api.operations.qualifications.searchQualificationQueue,
    isSearching ? { ...queryArgs, searchTerm: trimmed } : "skip",
  );

  const rows = isSearching ? (searchResults ?? []) : paginated.results;

  return (
    <div className="flex flex-col gap-4">
      <QualificationFilters
        searchTerm={searchTerm}
        onSearchTermChange={setSearchTerm}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        bookingProgramId={bookingProgramId}
        onBookingProgramChange={setBookingProgramId}
      />
      <QualificationTable
        rows={rows}
        isLoading={isSearching ? searchResults === undefined : paginated.status === "LoadingFirstPage"}
        onOpenRepair={setRepairRow}
      />
      <QualificationRepairSheet row={repairRow} onOpenChange={(open) => !open && setRepairRow(null)} />
      {!isSearching && paginated.status === "CanLoadMore" ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => paginated.loadMore(25)}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
```

**Step 3: Link rows safely.**

```tsx
// Path: app/workspace/operations/_components/qualification-table.tsx
import Link from "next/link";
import type { Id } from "@/convex/_generated/dataModel";
import { AlertTriangleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type QualificationRow = {
  _id: Id<"operationsQualificationRows">;
  opportunityId?: Id<"opportunities">;
  leadLabel?: string;
  slackUserLabel?: string;
  slackUserId: string;
  opportunityStatus?: string;
  bookingProgramName?: string;
  firstMeetingAt?: number;
  attributionResolution: "mapped" | "unmapped" | "internal" | "none";
};

export function QualificationTable({
  rows,
  isLoading,
  onOpenRepair,
}: QualificationTableProps) {
  if (isLoading) return <QualificationTableSkeleton />;

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Qualified By</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Booked Program</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Attribution</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row._id}>
              <TableCell>{row.leadLabel ?? "Unknown lead"}</TableCell>
              <TableCell>{row.slackUserLabel ?? row.slackUserId}</TableCell>
              <TableCell>{row.opportunityStatus ?? "Unlinked"}</TableCell>
              <TableCell>{row.bookingProgramName ?? "Unmapped"}</TableCell>
              <TableCell>{row.firstMeetingAt ? new Date(row.firstMeetingAt).toLocaleString() : "-"}</TableCell>
              <TableCell>
                <Badge variant={row.attributionResolution === "mapped" ? "secondary" : "outline"}>
                  {row.attributionResolution}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {row.opportunityId ? (
                  <Link href={`/workspace/opportunities/${row.opportunityId}`} className="text-sm text-primary hover:underline">
                    Open
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => onOpenRepair(row)}
                  >
                    <AlertTriangleIcon className="size-3" />
                    Repair
                  </button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

**Key implementation notes:**
- Use `usePaginatedQuery`, not a custom "load all then filter" hook.
- Rows with `resultKind: "unlinked"` should open `QualificationRepairSheet` with event ID, submitted time, Slack user, lead snapshot, handle snapshot, and any available raw error context. They must not render a broken opportunity link.
- Use URL state for filters only if the control set is stable; otherwise keep local state in MVP and add URL sync after finalizing filter combinations.
- If more than one primary indexed filter is selected, disable the later filters or show an explicit unsupported-combination message before the query throws.
- The table should horizontally scroll on small viewports rather than compressing columns until text overlaps.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/operations/_components/operations-page-client.tsx` | Modify | Render real Qualification tab |
| `app/workspace/operations/_components/qualification-tab.tsx` | Create | Query + tab container |
| `app/workspace/operations/_components/qualification-filters.tsx` | Create | Filter controls |
| `app/workspace/operations/_components/qualification-table.tsx` | Create | Rows and links |
| `app/workspace/operations/_components/qualification-repair-sheet.tsx` | Create | Unlinked row diagnostics |
| `app/workspace/operations/_components/operations-period.ts` | Create | Period helper |

---

### 3F — Slack Report Cross-Link

**Type:** Frontend
**Parallelizable:** Yes — depends on `/workspace/operations?tab=qualifications` existing.

**What:** Add a report-to-operations link in the Slack Qualifications report.

**Why:** Reports answer "how many"; Operations answers "which rows." Users need a direct bridge between them.

**Where:**
- `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` (modify)

**How:**

**Step 1: Add a link button to the report header.**

```tsx
// Path: app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx
import Link from "next/link";
import { ListChecksIcon, TargetIcon } from "lucide-react";

<div className="flex flex-wrap items-center gap-2">
  <Button asChild type="button" variant="outline" size="sm">
    <Link href="/workspace/operations?tab=qualifications">
      <ListChecksIcon data-icon="inline-start" />
      View Rows
    </Link>
  </Button>
  {report ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setIsTeamGoalDialogOpen(true)}
    >
      <TargetIcon data-icon="inline-start" />
      Team Goal
    </Button>
  ) : null}
</div>
```

**Key implementation notes:**
- Do not remove aggregate cards or trend charts.
- Avoid passing raw Slack IDs or social handles into analytics.
- If later URL date filters are added to Operations, map report business dates to `qualifiedAfter` and `qualifiedBefore`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` | Modify | Add Operations link |

---

### 3G — Backfill and Verification

**Type:** Backend / Manual
**Parallelizable:** No — run after ledger/projection code is deployed.

**What:** Backfill qualification events and projection rows for existing Slack-sourced opportunities, then verify counts.

**Why:** Operations should include historical Slack-qualified opportunities, not only new traffic.

**Where:**
- `convex/migrations.ts` (modify)
- `convex/admin/migrations.ts` (optional audit)

**How:**

**Step 1: Backfill one event for each Slack-sourced opportunity with `qualifiedBy`.**

```typescript
// Path: convex/migrations.ts
import { rebuildQualificationRow } from "./operations/projections";

export const backfillSlackQualificationEvents = migrations.define({
  table: "opportunities",
  batchSize: 100,
  migrateOne: async (ctx, opportunity) => {
    if (opportunity.source !== "slack_qualified" || !opportunity.qualifiedBy) return;

    const existing = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_opportunityId", (q) =>
        q.eq("tenantId", opportunity.tenantId).eq("opportunityId", opportunity._id),
      )
      .first();
    if (existing) return;

    const lead = await ctx.db.get(opportunity.leadId);
    const installations = await ctx.db
      .query("slackInstallations")
      .withIndex("by_teamId", (q) => q.eq("teamId", opportunity.qualifiedBy!.slackTeamId))
      .take(10);
    const installation = installations.find(
      (row) => row.tenantId === opportunity.tenantId && row.status === "active",
    );
    if (!installation) {
      throw new Error(`Missing active Slack installation for opportunity ${opportunity._id}`);
    }

    const eventId = await ctx.db.insert("slackQualificationEvents", {
      tenantId: opportunity.tenantId,
      installationId: installation._id,
      leadId: opportunity.leadId,
      opportunityId: opportunity._id,
      resultKind: "created_opportunity",
      qualifiedBy: opportunity.qualifiedBy,
      slackUserId: opportunity.qualifiedBy.slackUserId,
      slackTeamId: opportunity.qualifiedBy.slackTeamId,
      fullNameSnapshot: lead?.fullName ?? lead?.email ?? "Unknown lead",
      platform: "other_social",
      handleSnapshot: "",
      submittedAt: opportunity.qualifiedBy.submittedAt,
      createdAt: opportunity.createdAt,
    });

    await ctx.db.patch(opportunity._id, {
      qualifiedAt: opportunity.qualifiedBy.submittedAt,
    });
    await rebuildQualificationRow(ctx, eventId);
  },
});
```

**Step 2: Verify counts.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex run migrations:run '{"fn":"backfillSlackQualificationEvents","dryRun":true}'
npx convex run migrations:run '{"fn":"backfillSlackQualificationEvents"}'
pnpm tsc --noEmit
```

**Step 3: Add an audit query if needed.**

```typescript
// Path: convex/admin/migrations.ts
export const getQualificationProjectionReadiness = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdmin(ctx);
    return {
      // slackSourcedOpportunities,
      // qualificationEvents,
      // projectionRows,
      // rowsWithoutOpportunity,
      // rowsWithoutLead,
    };
  },
});
```

**Key implementation notes:**
- Existing `qualifiedBy` does not currently include `installationId`; the migration must resolve it from `slackInstallations` by `slackTeamId` and tenant.
- Backfill cannot recreate duplicate attempts that were never persisted. Document that limitation in migration notes.
- Run Phase 2 attribution backfill before final Phase 3 verification if attribution filters are included in the first UI release.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations.ts` | Modify | Historical event/projection backfill |
| `convex/admin/migrations.ts` | Modify | Readiness audit |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/operations/validators.ts` | Create | 3A |
| `convex/schema.ts` | Modify | 3A |
| `convex/operations/projections.ts` | Create | 3B |
| `convex/slack/createQualifiedLead.ts` | Modify | 3C |
| `convex/operations/qualifications.ts` | Create | 3D |
| `app/workspace/operations/_components/operations-page-client.tsx` | Modify | 3E |
| `app/workspace/operations/_components/qualification-tab.tsx` | Create | 3E |
| `app/workspace/operations/_components/qualification-filters.tsx` | Create | 3E |
| `app/workspace/operations/_components/qualification-table.tsx` | Create | 3E |
| `app/workspace/operations/_components/qualification-repair-sheet.tsx` | Create | 3E |
| `app/workspace/operations/_components/operations-period.ts` | Create | 3E |
| `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` | Modify | 3F |
| `convex/migrations.ts` | Modify | 3G |
| `convex/admin/migrations.ts` | Modify | 3G |
