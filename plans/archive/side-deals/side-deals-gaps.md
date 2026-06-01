# Side Deals Implementation Gap Report

Last reviewed: 2026-04-24

Status: audit artifact only. No implementation fixes were made as part of this report.

## Source Material

Plan and design documents reviewed:

- `plans/side-deals/side-deals-design.md`
- `plans/side-deals/phases/phase1.md`
- `plans/side-deals/phases/phase2.md`
- `plans/side-deals/phases/phase3.md`
- `plans/side-deals/phases/phase4.md`
- `plans/side-deals/phases/phase5.md`
- `plans/side-deals/phases/phase6.md`
- `plans/side-deals/phases/phase7.md`
- `plans/side-deals/phases/parallelization-strategy.md`
- `plans/side-deals/migration-notes.md`

Repository guidance used:

- `convex/_generated/ai/guidelines.md`
- `.agents/skills/convex-migration-helper/SKILL.md`
- `.docs/convex/nextjs.md`
- `.docs/convex/module-nextjs.md`

Important review constraints:

- Tenant identity must always come from authenticated Convex context, not client arguments.
- Convex queries should be indexed and bounded.
- Bounded reads must not silently change business correctness.
- Schema/data migrations must follow widen, migrate, verify, narrow.
- The user specifically requested gaps only, not fixes.

## Executive Verdict

The side-deals work is mostly implemented. The codebase contains the main expected surfaces:

- Widened Convex schema for opportunity source, manual creation key, latest activity, side-deal origins, and stale nudge reason.
- Shared source helpers and activity helpers.
- Manual opportunity creation.
- Side-deal payment, lost, void, and delete mutations.
- Opportunity list, search, create, and detail pages.
- Stale side-deal nudge cron.
- Reminder routing for stale nudges.
- Dashboard/reporting origin labels and side-deal period metrics.
- Pipeline links into canonical opportunity detail pages.
- Navigation and command palette entries.

The implementation is not fully phase-complete because four gaps remain:

1. P1: Search can silently miss valid filtered opportunities.
2. P2: Manual side deals can be created for leads that cannot later convert.
3. P2: Production backfill verification is not proven in repository evidence.
4. P3: One schema index name deviates from the phase contract and Convex naming guidance.

The P1 search issue is the main functional shortcut. The P2 lead eligibility issue is the main workflow integrity issue. The migration verification issue is a release-process gap. The index name mismatch is a maintainability and plan-traceability gap.

## Verification Performed During Review

Commands that passed:

```bash
pnpm tsc --noEmit
npx convex dev --once --typecheck disable --tail-logs disable
```

Focused lint over the side-deals implementation paths passed.

Full repository lint did not pass, but the failures observed were in unrelated existing areas outside the side-deals paths reviewed here. Full lint therefore cannot currently be treated as a clean release gate for this feature until the wider repository lint state is addressed.

## Phase Coverage Matrix

| Phase | Intended outcome | Implementation status | Remaining gaps |
| --- | --- | --- | --- |
| Phase 1 | Widen schema, add side-deal source/origin fields, add activity indexes, backfill legacy opportunities, document future narrow deploy. | Mostly implemented. Schema is widened, helpers exist, Calendly/manual writers populate new fields, migration exists, narrow deploy is documented. | Index name mismatch. Production verification proof is not recorded. |
| Phase 2 | Backend API for manual opportunity creation, side-deal payment, mark lost, list/search/picker queries. | Mostly implemented. Mutations and queries exist and are auth/tenant scoped. | Search correctness gap. Manual creation can attach to non-convertible leads. |
| Phase 3 | `/workspace/opportunities` list with URL filters, pagination, search mode, source/status/closer/activity columns, navigation entry. | Mostly implemented. UI uses `usePaginatedQuery`, URL filters, source/status/period/closer filters, and list/detail navigation. | Search mode does not preserve list semantics under truncation. |
| Phase 4 | Full-page create opportunity form for existing or new lead, admin closer picker, `?leadId=` prefill, idempotency. | Mostly implemented. Form, validation, idempotency, admin closer assignment, and route push exist. | Existing/new lead flow can produce an opportunity that cannot later record payment if the resolved lead is already converted or otherwise non-convertible. |
| Phase 5 | Opportunity detail page with side-deal actions, side-deal payments, mark lost, Calendly meeting separation, section boundaries. | Implemented at the reviewed level. Detail query and client expose correct source-aware behavior and permissions. | Depends on Gap 2 because invalidly created side deals reach this page and fail during payment. |
| Phase 6 | Admin void for side-deal payments, aggregate/stat reversal, reporting origin labels, dashboard side-deal metrics. | Implemented at the reviewed level. Void mutation is admin-only and side-deal scoped; reporting labels exist. | No primary gap found in Phase 6 during this pass. |
| Phase 7 | Stale side-deal nudges, reminder routing, stale badge, empty opportunity deletion, stale nudge expiration. | Implemented at the reviewed level. Cron, follow-up reason, reminder routing, deletion guard, and nudge expiration exist. | No primary gap found in Phase 7 during this pass. |

## Codebase Implementation Map

This section lists the main files reviewed and the role each plays in the side-deals feature.

### Schema And Shared Backend Helpers

- `convex/schema.ts`
  - Adds optional `opportunities.source`.
  - Adds optional `opportunities.manualCreationKey`.
  - Adds optional `opportunities.notes`.
  - Adds optional `opportunities.latestActivityAt`.
  - Adds source/activity indexes for opportunity listing.
  - Adds `leadIdentifiers.source = "side_deal"`.
  - Adds side-deal payment origins.
  - Adds `followUps.reason = "stale_opportunity_nudge"`.
  - Adds `followUps.by_opportunityId_and_status_and_reason`.

- `convex/lib/sideDeals.ts`
  - Normalizes legacy opportunities with missing `source` to `calendly`.
  - Classifies side-deal opportunities.
  - Classifies side-deal payment origins.

- `convex/lib/opportunityActivity.ts`
  - Computes `latestActivityAt`.
  - Centralizes lifecycle patching.
  - Keeps aggregates in sync when lifecycle fields change.

- `convex/lib/staleOpportunityNudges.ts`
  - Expires pending stale opportunity nudges after payment or lost transitions.

- `convex/lib/paymentTypes.ts`
  - Extends payment origin validators and commissionable origin classification with `closer_side_deal` and `admin_side_deal`.

### Migration

- `convex/migrations.ts`
  - Defines `backfillOpportunitySourceAndActivity`.
  - Uses `@convex-dev/migrations`.
  - Backfills missing `source` to `calendly`.
  - Backfills missing `latestActivityAt` from lifecycle timestamps.

- `plans/side-deals/migration-notes.md`
  - Documents dev dry-run and dev execution.
  - Documents production commands to run later.
  - Documents manual verification steps.
  - Does not record production verification output.

### Manual Opportunity Backend

- `convex/opportunities/createManual.ts`
  - Implements `api.opportunities.createManual.createManual`.
  - Enforces authenticated tenant user.
  - Allows closers and admins.
  - Enforces tenant-scoped idempotency by `manualCreationKey`.
  - Supports existing lead or new lead input.
  - Enforces admin closer assignment.
  - Creates a `source: "side_deal"` opportunity in `in_progress`.
  - Emits `lead.created` if a lead was created.
  - Emits `opportunity.created`.

- `convex/leads/identityResolution.ts`
  - Extracted shared lead identity resolution.
  - Searches by email, identifier, social handle, and phone.
  - Follows merge chains.
  - Creates lead and identifiers when missing.
  - Does not enforce side-deal conversion eligibility.

### Side-Deal Mutations

- `convex/sideDeals/logPayment.ts`
  - Implements side-deal payment recording.
  - Rejects non-side-deal opportunities.
  - Enforces closer ownership for non-admins.
  - Inserts payment with no `meetingId`.
  - Uses `closer_side_deal` or `admin_side_deal` origin.
  - Moves opportunity to `payment_received`.
  - Expires stale nudges.
  - Updates stats and aggregates.
  - Executes lead-to-customer conversion.
  - Emits payment and opportunity events.

- `convex/sideDeals/markLost.ts`
  - Rejects non-side-deal opportunities.
  - Enforces closer ownership for non-admins.
  - Moves in-progress side deal to lost.
  - Expires stale nudges.
  - Updates active/lost counters.
  - Emits event.

- `convex/sideDeals/voidPayment.ts`
  - Admin-only.
  - Rejects non-side-deal, non-recorded, already-disputed, and non-opportunity payments.
  - Marks payment disputed.
  - Moves side-deal opportunity to lost with void reason.
  - Reverses payment aggregate and stats.
  - Rolls back customer conversion if possible.
  - Emits `payment.voided` and `opportunity.status_changed`.

- `convex/sideDeals/deleteEmptyOpportunity.ts`
  - Closer/admin permitted, with closer ownership enforcement.
  - Allows only side-deal `in_progress` opportunities.
  - Rejects if any payment or meeting exists.
  - Rejects real follow-up work.
  - Allows only stale nudges to be deleted alongside the opportunity.
  - Deletes opportunity aggregate and updates tenant stats.
  - Emits `opportunity.deleted`.

### Opportunity Query Backend

- `convex/opportunities/listQueries.ts`
  - Implements paginated opportunity list using latest activity indexes.
  - Implements search through lead search index.
  - Enriches opportunity rows with lead, closer, normalized source, and stale nudge state.
  - Contains the P1 search correctness gap.

- `convex/opportunities/detailQuery.ts`
  - Implements source-aware opportunity detail query.
  - Enforces tenant and closer access.
  - Loads lead, closer, meetings, payments, events, stale nudge state, and delete/action permissions.

- `convex/leads/queries.ts`
  - Implements lead picker search and selected-lead lookup.
  - Does not filter picker results to active/convertible leads for side-deal creation.

### Frontend Surfaces

- `app/workspace/opportunities/page.tsx`
  - Thin RSC wrapper with `unstable_instant = false`.

- `app/workspace/opportunities/_components/opportunities-page-client.tsx`
  - Uses `usePaginatedQuery` for list mode with 25 initial rows.
  - Switches to search mode at 2+ characters.
  - Keeps source/status/period/closer filters in URL state.
  - Opens detail in a new tab.

- `app/workspace/opportunities/_components/opportunity-filters.tsx`
  - Implements source/status/period filters.
  - Shows closer filter for admins.

- `app/workspace/opportunities/_components/opportunities-table.tsx`
  - Shows source, status, stale badge, closer, latest activity, created date, and row actions.

- `app/workspace/opportunities/new/*`
  - Implements create-opportunity page and client form.
  - Supports existing/new lead modes.
  - Supports admin closer assignment.
  - Supports `?leadId=` prefill.

- `app/workspace/opportunities/[opportunityId]/*`
  - Implements opportunity detail page and side-deal dialogs.
  - Includes payment, mark lost, void, delete, meetings, payments, and activity sections.

- `app/workspace/_components/workspace-shell-client.tsx`
  - Adds Opportunities navigation.

- `components/command-palette.tsx`
  - Adds Opportunities and New Opportunity commands.

- `app/workspace/closer/_components/reminders-section.tsx`
  - Routes stale nudges to canonical opportunity detail pages.

## Gap 1: Opportunity Search Can Miss Valid Filtered Results

Severity: P1

Primary location:

- `convex/opportunities/listQueries.ts:384-432`

Related frontend location:

- `app/workspace/opportunities/_components/opportunities-page-client.tsx:137-155`

Related phase requirements:

- Phase 2: opportunity listing/search queries are tenant-safe, role-scoped, bounded, and filter-correct.
- Phase 3: search mode at 2+ characters preserves the same source/status/period/closer filtering behavior as list mode.
- Side-deals design: `/workspace/opportunities` is a reliable entity-browse experience for all opportunities.
- Convex guidance: use bounded indexed queries, but do not use query shortcuts that change business correctness.

### Current Code

The client switches from paginated list mode to search mode once the term reaches two characters:

```tsx
const isSearching = trimmedSearchTerm.length >= 2;

const {
  results: paginatedOpportunities,
  status: paginationStatus,
  loadMore,
} = usePaginatedQuery(
  api.opportunities.listQueries.listOpportunities,
  isSearching ? "skip" : queryArgs,
  { initialNumItems: 25 },
);

const searchResults = useQuery(
  api.opportunities.listQueries.searchOpportunities,
  isSearching
    ? {
        ...queryArgs,
        searchTerm: trimmedSearchTerm,
      }
    : "skip",
);
```

The backend search path first searches leads, then fetches only the first 10 opportunities per matching lead, then applies opportunity filters:

```ts
const matchingLeads = await ctx.db
  .query("leads")
  .withSearchIndex("search_leads", (q) =>
    q.search("searchText", term).eq("tenantId", tenantId),
  )
  .take(25);

const opportunityPages = await Promise.all(
  matchingLeads.map((lead) =>
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", lead._id),
      )
      .order("desc")
      .take(10),
  ),
);

const filtered = opportunityPages.flat().filter((opportunity) => {
  if (closerId && opportunity.assignedCloserId !== closerId) {
    return false;
  }
  if (args.statusFilter && opportunity.status !== args.statusFilter) {
    return false;
  }
  if (
    args.sourceFilter &&
    normalizeOpportunitySource(opportunity) !== args.sourceFilter
  ) {
    return false;
  }
  const activity = opportunity.latestActivityAt ?? opportunity.updatedAt;
  if (periodStart !== undefined && activity < periodStart) {
    return false;
  }
  if (periodEnd !== undefined && activity >= periodEnd) {
    return false;
  }
  return true;
});

return await enrichOpportunityRows(ctx, filtered.slice(0, 50));
```

### Root Cause

The query is bounded, which is good, but it applies the bounds before applying the opportunity filters that define the user's view.

This creates a semantic mismatch:

- List mode starts from opportunities and uses source/status/closer/activity indexes.
- Search mode starts from leads and truncates lead/opportunity candidates before source/status/closer/activity filters are applied.

The search function is therefore not "the same list with a search term." It is "the first 25 matching leads, the first 10 opportunities for each, then filters."

### Concrete Failure Modes

Failure mode A: matching lead is outside the first 25 lead search hits.

1. Admin opens `/workspace/opportunities`.
2. Admin filters `source = side_deal` and `status = payment_received`.
3. Admin searches `john`.
4. The lead search returns 40 leads matching `john`.
5. The only matching side-deal payment opportunity belongs to lead hit 26.
6. Backend takes only 25 leads.
7. The result is omitted.

Failure mode B: matching opportunity is outside the first 10 opportunities for a lead.

1. A lead has 12 opportunities.
2. The first 10 by descending order are Calendly or non-matching statuses.
3. The 11th opportunity is the side-deal opportunity matching the active filters.
4. Backend takes only 10 opportunities for that lead.
5. The matching opportunity is omitted.

Failure mode C: period filtering is applied too late.

1. Search returns candidates with old activity first or high search rank first.
2. Period filter is `today`.
3. A valid matching opportunity exists later in the candidate space.
4. The candidate set is truncated before the period filter can see that opportunity.

### Why This Violates The Plan

Phase 3 treats search as a mode of the opportunities list, not as a best-effort lead lookup. The filters are user-visible controls on the same page, so the user expects them to mean the same thing in list mode and search mode.

The current implementation makes search fast and bounded by accepting false negatives. That is the shortcut the plan explicitly tried to avoid.

### Runtime Impact

- Valid opportunities can disappear from search.
- Admin side-deal review can miss real payment opportunities.
- Closers can fail to find their own side deals.
- Support/debugging becomes difficult because list mode can show a row that search mode omits under equivalent filters.

### Performance Analysis

The current query has a predictable read ceiling:

- Up to 25 lead search hits.
- Up to 250 opportunity reads.
- Enrichment reads for unique leads and closers.
- One pending stale nudge lookup per returned opportunity.

That read ceiling protects Convex bandwidth, but it is achieved by sacrificing correctness. The better target is a bounded query shape whose bounds align with the entity being listed: opportunities.

### Recommended Fix Direction

Preferred direction: introduce an opportunity search projection rather than searching leads first.

The page being searched is opportunities. The search index should therefore produce opportunity IDs directly, with enough denormalized fields to apply the same opportunity filters before truncation where possible.

#### Option A: Opportunity Search Projection Table

Add a projection table that mirrors the searchable and filterable fields needed by `/workspace/opportunities`.

Example schema direction:

```ts
opportunitySearch: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  assignedCloserId: v.optional(v.id("users")),
  source: v.union(v.literal("calendly"), v.literal("side_deal")),
  status: opportunityStatusValidator,
  latestActivityAt: v.number(),
  searchText: v.string(),
  updatedAt: v.number(),
})
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_latestActivityAt", ["tenantId", "latestActivityAt"])
  .searchIndex("search_opportunities", {
    searchField: "searchText",
    filterFields: ["tenantId", "source", "status", "assignedCloserId"],
  });
```

Then keep it synchronized when:

- An opportunity is created.
- Opportunity status/source/assigned closer/latest activity changes.
- Lead identity fields change.
- Leads are merged.

Example writer helper shape:

```ts
export async function upsertOpportunitySearchProjection(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) {
    return;
  }

  const lead = await ctx.db.get(opportunity.leadId);
  const searchText = buildOpportunitySearchText({
    leadFullName: lead?.fullName,
    leadEmail: lead?.email,
    leadPhone: lead?.phone,
    notes: opportunity.notes,
  });

  const existing = await ctx.db
    .query("opportunitySearch")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .unique();

  const row = {
    tenantId: opportunity.tenantId,
    opportunityId,
    leadId: opportunity.leadId,
    assignedCloserId: opportunity.assignedCloserId,
    source: normalizeOpportunitySource(opportunity),
    status: opportunity.status,
    latestActivityAt: opportunity.latestActivityAt ?? opportunity.updatedAt,
    searchText,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("opportunitySearch", row);
  }
}
```

Query direction:

```ts
const matches = await ctx.db
  .query("opportunitySearch")
  .withSearchIndex("search_opportunities", (q) => {
    let search = q.search("searchText", term).eq("tenantId", tenantId);
    if (args.sourceFilter) {
      search = search.eq("source", args.sourceFilter);
    }
    if (args.statusFilter) {
      search = search.eq("status", args.statusFilter);
    }
    if (closerId) {
      search = search.eq("assignedCloserId", closerId);
    }
    return search;
  })
  .take(SEARCH_CANDIDATE_LIMIT);
```

Important caveat: Convex search indexes support search plus equality filter fields. They do not replace an activity range index. If `periodFilter` must be fully exact, either:

- Include a token/index design that can query by activity range before truncation, or
- Page through enough search candidates to guarantee the period filter can be evaluated correctly, with a documented cap.

#### Option B: Token Projection For Exact Filter Semantics

If exact source/status/closer/period semantics matter more than full-text relevance, create a tokenized projection where each searchable token is a row. This allows composite indexes with `latestActivityAt`.

Example direction:

```ts
opportunitySearchTokens: defineTable({
  tenantId: v.id("tenants"),
  token: v.string(),
  opportunityId: v.id("opportunities"),
  assignedCloserId: v.optional(v.id("users")),
  source: v.union(v.literal("calendly"), v.literal("side_deal")),
  status: opportunityStatusValidator,
  latestActivityAt: v.number(),
})
  .index("by_tenantId_and_token_and_latestActivityAt", [
    "tenantId",
    "token",
    "latestActivityAt",
  ])
  .index("by_tenantId_and_token_and_source_and_status_and_latestActivityAt", [
    "tenantId",
    "token",
    "source",
    "status",
    "latestActivityAt",
  ])
  .index(
    "by_tenantId_and_token_and_assignedCloserId_and_source_and_status_and_latestActivityAt",
    ["tenantId", "token", "assignedCloserId", "source", "status", "latestActivityAt"],
  );
```

This can support "search by exact normalized token or prefix token" and preserve latest-activity ordering. The tradeoff is more write-time projection maintenance.

#### Option C: Temporary Lead-First Search With Explicit Scan Cap

If a projection is too much for the immediate fix, make the current approach less incorrect by paginating lead search results until enough filtered opportunity rows are found or a documented scan cap is reached.

This should be considered a temporary mitigation, not the final design.

Example direction:

```ts
const MAX_LEADS_SCANNED = 200;
const TARGET_ROWS = 50;

let cursor: string | null = null;
let scanned = 0;
const filtered: Doc<"opportunities">[] = [];

while (filtered.length < TARGET_ROWS && scanned < MAX_LEADS_SCANNED) {
  const leadPage = await ctx.db
    .query("leads")
    .withSearchIndex("search_leads", (q) =>
      q.search("searchText", term).eq("tenantId", tenantId),
    )
    .paginate({ numItems: 25, cursor });

  scanned += leadPage.page.length;

  for (const lead of leadPage.page) {
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", lead._id),
      )
      .order("desc")
      .take(50);

    filtered.push(...opportunities.filter((opportunity) =>
      opportunityMatchesFilters(opportunity, {
        closerId,
        statusFilter: args.statusFilter,
        sourceFilter: args.sourceFilter,
        periodStart,
        periodEnd,
      }),
    ));
  }

  if (leadPage.isDone) {
    break;
  }
  cursor = leadPage.continueCursor;
}
```

This reduces false negatives but still has a cap. If this route is chosen, the cap must be documented in product behavior and tested.

### Recommended Tests

Add backend tests or seeded Convex smoke checks for:

```ts
// Search hit after the first 25 leads still appears.
// Setup: 26 leads whose searchText matches "alex".
// Only lead 26 has a side_deal/payment_received opportunity.
// Expect: searchOpportunities({ searchTerm: "alex", sourceFilter: "side_deal", statusFilter: "payment_received" }) includes it.
```

```ts
// Matching opportunity after the first 10 opportunities for one lead still appears.
// Setup: one matching lead with 11 opportunities.
// First 10 do not match source/status; 11th does.
// Expect: searchOpportunities returns the matching opportunity.
```

```ts
// Closer scoping remains authoritative.
// Setup: admin and closer users; multiple matching opportunities across closers.
// Expect: closer only sees own rows, admin can filter by closer.
```

### Acceptance Criteria To Close

- Search mode and list mode are semantically aligned for source/status/period/closer filters.
- Search cannot omit a valid filtered opportunity solely because its lead was outside the first 25 lead hits.
- Search cannot omit a valid filtered opportunity solely because it was outside the first 10 opportunities for a lead.
- Closer role scoping remains enforced server-side.
- Query reads remain bounded by an explicit, documented design.
- Any new projection table or required field is rolled out with a migration/backfill plan.

## Gap 2: Manual Side Deals Can Be Created For Leads That Cannot Convert

Severity: P2

Primary location:

- `convex/opportunities/createManual.ts:37-50`

Related locations:

- `convex/opportunities/createManual.ts:56-66`
- `convex/leads/identityResolution.ts:282-368`
- `convex/leads/queries.ts:203-230`
- `convex/customers/conversion.ts:58-63`
- `convex/sideDeals/logPayment.ts:129-135`

Related phase requirements:

- Phase 2: manual creation attaches to an existing lead or creates/resolves a new lead.
- Phase 2: `sideDeals.logPayment` transitions the side-deal opportunity and converts the lead to a customer.
- Phase 4: create page supports both existing-lead and new-lead flows.
- Phase 5: side-deal detail supports record payment for valid side-deal opportunities.

### Current Code

Existing-lead path in manual creation:

```ts
if (args.existingLeadId) {
  const lead = await ctx.db.get(args.existingLeadId);
  if (!lead || lead.tenantId !== args.tenantId) {
    throw new Error("Selected lead not found.");
  }
  if (lead.status === "merged" && lead.mergedIntoLeadId) {
    const target = await ctx.db.get(lead.mergedIntoLeadId);
    if (!target || target.tenantId !== args.tenantId || target.status === "merged") {
      throw new Error("Selected lead has been merged but the target lead is unavailable.");
    }
    return { leadId: target._id, leadWasCreated: false };
  }
  return { leadId: lead._id, leadWasCreated: false };
}
```

New-lead path can resolve to an existing lead:

```ts
const result = await resolveLeadIdentity(ctx, {
  tenantId: args.tenantId,
  fullName: args.newLeadInput.fullName,
  email: args.newLeadInput.email,
  phone: args.newLeadInput.phone,
  socialHandle: args.newLeadInput.socialHandle,
  identifierSource: "side_deal",
  createdAt: args.now,
  createIdentifiers: true,
});
return { leadId: result.leadId, leadWasCreated: result.created };
```

Payment later depends on conversion:

```ts
let customerId = await executeConversion(ctx, {
  tenantId,
  leadId: opportunity.leadId,
  convertedByUserId: userId,
  winningOpportunityId: args.opportunityId,
  winningMeetingId: undefined,
});
```

Conversion rejects non-convertible leads:

```ts
const currentStatus = lead.status;
if (!validateLeadTransition(currentStatus, "converted")) {
  throw new Error(
    `Cannot convert lead with status "${currentStatus}". Only active leads can be converted.`,
  );
}
```

The lead picker currently searches all lead statuses:

```ts
const results = await ctx.db
  .query("leads")
  .withSearchIndex("search_leads", (q) =>
    q.search("searchText", term).eq("tenantId", tenantId),
  )
  .take(20);
```

### Root Cause

Manual opportunity creation validates tenant ownership and merge resolution, but it does not validate whether the resolved lead can complete the side-deal payment path.

There are two ways to get an ineligible lead:

1. The user explicitly selects an existing converted/non-active lead.
2. The user enters "new" lead information, but identity resolution matches an existing converted/non-active lead by email, phone, or social identifier.

The second case is especially subtle because the user thinks they created a new lead, but the backend silently attaches to an existing lead.

### Runtime Behavior

Convex mutations are transactional, so if `logPayment` throws during conversion, the payment insert and opportunity payment transition from that mutation should roll back. That prevents partial payment corruption.

However, the side-deal opportunity created earlier remains in `in_progress`. The user has a valid-looking opportunity that cannot complete the intended payment flow.

### Concrete Failure Mode

1. Lead `A` is already `converted`.
2. Closer opens `/workspace/opportunities/new`.
3. Closer selects lead `A`, or enters an email that resolves to lead `A`.
4. `createManual` creates a `source: "side_deal"` opportunity in `in_progress`.
5. Closer opens the opportunity detail page.
6. UI shows record payment because the opportunity is side-deal and in progress.
7. Closer submits payment.
8. `executeConversion` rejects the lead with `Cannot convert lead with status "converted"`.
9. Payment fails. Opportunity remains in progress.

### Why This Violates The Plan

The side-deals MVP path is:

1. Create/resolve lead.
2. Create side-deal opportunity.
3. Record payment.
4. Convert lead to customer.
5. Classify payment as side-deal revenue.

Allowing creation for leads that cannot convert breaks that path. The failure happens too late and is avoidable at creation time.

### Recommended Fix Direction

Add a backend eligibility guard at the manual creation boundary. The backend must be authoritative; UI filtering is only a usability improvement.

#### Backend Helper

Add a helper near `createManual.ts` or in a shared lead eligibility module:

```ts
function assertLeadCanStartManualSideDeal(lead: Doc<"leads">): void {
  if (lead.status !== "active") {
    throw new Error(
      `Selected lead is ${lead.status}. Only active leads can be used for a new side-deal opportunity.`,
    );
  }
}
```

If business rules later allow repeat sales against existing customers, that should be a separate customer-direct or repeat-sale workflow. It should not be smuggled through the lead-conversion side-deal path.

#### Existing Lead Path

After merge resolution, validate the final lead:

```ts
if (args.existingLeadId) {
  const lead = await ctx.db.get(args.existingLeadId);
  if (!lead || lead.tenantId !== args.tenantId) {
    throw new Error("Selected lead not found.");
  }

  const resolvedLead =
    lead.status === "merged" && lead.mergedIntoLeadId
      ? await ctx.db.get(lead.mergedIntoLeadId)
      : lead;

  if (!resolvedLead || resolvedLead.tenantId !== args.tenantId) {
    throw new Error("Selected lead has been merged but the target lead is unavailable.");
  }

  assertLeadCanStartManualSideDeal(resolvedLead);
  return { leadId: resolvedLead._id, leadWasCreated: false };
}
```

#### New Lead Identity Resolution Path

Because `resolveLeadIdentity` returns the resolved `lead`, validate it before returning:

```ts
const result = await resolveLeadIdentity(ctx, {
  tenantId: args.tenantId,
  fullName: args.newLeadInput.fullName,
  email: args.newLeadInput.email,
  phone: args.newLeadInput.phone,
  socialHandle: args.newLeadInput.socialHandle,
  identifierSource: "side_deal",
  createdAt: args.now,
  createIdentifiers: true,
});

assertLeadCanStartManualSideDeal(result.lead);
return { leadId: result.leadId, leadWasCreated: result.created };
```

#### Picker Query Filtering

The lead search index already has `status` as a filter field. Use it for the create-opportunity picker:

```ts
const results = await ctx.db
  .query("leads")
  .withSearchIndex("search_leads", (q) =>
    q
      .search("searchText", term)
      .eq("tenantId", tenantId)
      .eq("status", "active"),
  )
  .take(20);
```

Also update selected-lead lookup for `?leadId=` prefill so it does not present a converted lead as selectable in the create page:

```ts
if (resolvedLead.status !== "active") {
  return null;
}
```

If other pages use the same picker query for non-creation workflows, split the API into:

- `searchLeadsForPicker`
- `searchActiveLeadsForOpportunityCreate`

That avoids changing unrelated lead search behavior.

### Recommended Tests

Add mutation smoke tests or seeded manual checks for:

```ts
// Existing converted lead is rejected.
// Setup: lead.status = "converted".
// Action: createManual({ existingLeadId: lead._id, ... }).
// Expect: mutation throws before opportunity insert.
```

```ts
// New lead input resolving to converted lead is rejected.
// Setup: converted lead with email "buyer@example.com".
// Action: createManual({ newLeadInput: { email: "buyer@example.com", ... } }).
// Expect: mutation throws before opportunity insert.
```

```ts
// Active lead still works.
// Setup: lead.status = "active".
// Action: createManual then sideDeals.logPayment.
// Expect: opportunity reaches payment_received and customer is created.
```

```ts
// Picker excludes converted leads.
// Setup: active and converted leads matching the same search term.
// Action: search active opportunity-create picker.
// Expect: only active lead appears.
```

### Acceptance Criteria To Close

- `createManual` rejects non-active resolved leads before inserting an opportunity.
- The rejection applies to both `existingLeadId` and `newLeadInput` identity matches.
- The create page does not show converted/non-active leads as selectable for new side-deal opportunities.
- A successfully created side-deal opportunity is eligible to complete `sideDeals.logPayment` unless its status changes later through another valid flow.
- The user-facing error clearly explains why the lead cannot be used.

## Gap 3: Production Backfill Verification Is Not Proven In Repository Evidence

Severity: P2

Primary location:

- `plans/side-deals/migration-notes.md:33-58`

Related location:

- `convex/migrations.ts:10-30`

Related phase requirements:

- Phase 1: use widen-migrate-narrow.
- Phase 1: dry run reports expected records.
- Phase 1: production execution is verified.
- Phase 1: verification proves zero opportunities missing `source`.
- Phase 1: verification proves zero opportunities missing `latestActivityAt`.
- Phase 1: narrow deploy is documented but not merged until production verification passes.

### Current Code

Migration definition:

```ts
export const backfillOpportunitySourceAndActivity = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, opportunity) => {
    const patch: {
      source?: "calendly";
      latestActivityAt?: number;
    } = {};

    if (opportunity.source === undefined) {
      patch.source = "calendly";
    }

    if (opportunity.latestActivityAt === undefined) {
      patch.latestActivityAt = computeLatestActivityAt(opportunity);
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(opportunity._id, patch);
    }
  },
});
```

Migration notes record dev dry run and dev execution:

```md
Dev dry run was executed successfully on 2026-04-24:

- Command: `npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity","dryRun":true}'`
- Result: `processed: 60`, status `DRY RUN: Migration was started and finished in one batch.`

Dev execution was then run successfully on 2026-04-24:

- Command: `npx convex run migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity"}'`
- Result: `processed: 60`, status `Migration was started and finished in one batch.`
```

Production commands are documented as future work:

```bash
npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity","dryRun":true}'
npx convex run --prod migrations:run '{"fn":"migrations:backfillOpportunitySourceAndActivity"}'
```

### Root Cause

The migration implementation exists and the widened schema is correct. The gap is evidence and closure:

- Dev proof exists.
- Production proof does not exist in the repository.
- Verification steps are written as instructions, not as recorded results.
- There is no checked-in verification helper that can be run to prove the backfill is complete.

### Why This Matters

The current schema intentionally keeps `source` and `latestActivityAt` optional. That is correct for the widen deploy.

However, later phases rely heavily on those fields:

- Opportunity list ordering uses `latestActivityAt`.
- Source filters depend on `source`.
- Stale side-deal logic depends on `source`.
- Reporting and detail views normalize legacy source.

Readers currently have compatibility fallbacks, but the phase explicitly required proof that the data was backfilled before any future narrow deploy.

### Migration Skill Checklist Comparison

The migration-helper skill's workflow is:

1. Widen schema.
2. Update readers to handle old and new formats.
3. Update writers to write the new format.
4. Deploy.
5. Run dry run.
6. Run migration.
7. Verify all documents are migrated.
8. Narrow schema later.

Current status:

- Steps 1-4 are implemented.
- Dev dry run and dev migration are documented.
- Production dry run/migration are documented as commands, not results.
- Step 7 is not proven for production.
- Step 8 is correctly not merged.

### Recommended Fix Direction

Add a durable verification path and record the production output.

#### Option A: Verification Migration That Throws On Missing Rows

Use the existing migrations component to scan the `opportunities` table and fail if a row is still missing required backfill fields.

Example direction:

```ts
export const assertOpportunitySourceAndActivityBackfilled = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (_ctx, opportunity) => {
    if (opportunity.source === undefined) {
      throw new Error(`Opportunity ${opportunity._id} is missing source`);
    }
    if (opportunity.latestActivityAt === undefined) {
      throw new Error(`Opportunity ${opportunity._id} is missing latestActivityAt`);
    }
  },
});
```

Then run:

```bash
npx convex run --prod migrations:run '{"fn":"migrations:assertOpportunitySourceAndActivityBackfilled","dryRun":true}'
```

If it completes across all opportunities, record the output in `migration-notes.md`.

#### Option B: Temporary Verification Report

If counts and sample IDs are desired, add a temporary internal verification function that scans in batches and writes a report document. This is heavier than Option A but gives better release evidence.

Example report shape:

```ts
verificationReports: defineTable({
  name: v.string(),
  missingSource: v.number(),
  missingLatestActivityAt: v.number(),
  sampleOpportunityIds: v.array(v.id("opportunities")),
  completedAt: v.number(),
}).index("by_name", ["name"]);
```

Then a batched internal mutation can accumulate:

```ts
export const verifyOpportunityBackfillBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    missingSource: v.optional(v.number()),
    missingLatestActivityAt: v.optional(v.number()),
    sampleOpportunityIds: v.optional(v.array(v.id("opportunities"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("opportunities")
      .paginate({ numItems: 200, cursor: args.cursor ?? null });

    let missingSource = args.missingSource ?? 0;
    let missingLatestActivityAt = args.missingLatestActivityAt ?? 0;
    const sampleOpportunityIds = [...(args.sampleOpportunityIds ?? [])];

    for (const opportunity of page.page) {
      if (opportunity.source === undefined) {
        missingSource += 1;
        if (sampleOpportunityIds.length < 10) {
          sampleOpportunityIds.push(opportunity._id);
        }
      }
      if (opportunity.latestActivityAt === undefined) {
        missingLatestActivityAt += 1;
        if (sampleOpportunityIds.length < 10) {
          sampleOpportunityIds.push(opportunity._id);
        }
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.admin.migrations.verifyOpportunityBackfillBatch,
        {
          cursor: page.continueCursor,
          missingSource,
          missingLatestActivityAt,
          sampleOpportunityIds,
        },
      );
      return null;
    }

    await ctx.db.insert("verificationReports", {
      name: "opportunity-source-latestActivityAt-backfill",
      missingSource,
      missingLatestActivityAt,
      sampleOpportunityIds,
      completedAt: Date.now(),
    });

    return null;
  },
});
```

Use Option B only if the report artifact is worth the extra temporary schema/code. Option A is sufficient for a simple assertive release gate.

### Required Documentation Update

After production commands are run, update `plans/side-deals/migration-notes.md` with concrete output:

```md
Production dry run was executed on YYYY-MM-DD:

- Command: `...`
- Result: `processed: N`, status `DRY RUN: ...`

Production execution was executed on YYYY-MM-DD:

- Command: `...`
- Result: `processed: N`, status `Migration was started and finished ...`

Production verification was executed on YYYY-MM-DD:

- Command: `...assertOpportunitySourceAndActivityBackfilled...`
- Result: completed with zero missing `source` and zero missing `latestActivityAt`.
```

### Acceptance Criteria To Close

- Production dry-run output is recorded.
- Production migration output is recorded.
- A production verification command is recorded.
- Verification proves zero opportunities missing `source`.
- Verification proves zero opportunities missing `latestActivityAt`.
- `source` and `latestActivityAt` remain optional until the verification evidence exists.
- Any future narrow deploy is a separate deploy after verification.

## Gap 4: One Schema Index Name Deviates From The Phase Contract

Severity: P3

Primary location:

- `convex/schema.ts:354-363`

Related query reference:

- `convex/opportunities/listQueries.ts:116-118`

Related phase requirements:

- Phase 1: add source/status/assigned-closer/latest-activity indexes with the planned names.
- Convex guidelines: index names should include all indexed fields.

### Current Code

Current index:

```ts
.index(
  "by_tenantId_closerId_source_status_latestActivityAt",
  [
    "tenantId",
    "assignedCloserId",
    "source",
    "status",
    "latestActivityAt",
  ],
),
```

Current query reference:

```ts
return ctx.db.query("opportunities").withIndex(
  "by_tenantId_closerId_source_status_latestActivityAt",
  (q) => {
    const query = q
      .eq("tenantId", args.tenantId)
      .eq("assignedCloserId", closerId)
      .eq("source", source)
      .eq("status", status);
    ...
  },
);
```

Planned index name:

```ts
by_tenantId_and_assignedCloserId_and_source_and_status_and_latestActivityAt
```

### Root Cause

The index fields are correct, but the index name is not:

- It omits the `and` naming convention used by the rest of the schema.
- It uses `closerId` instead of the actual field name `assignedCloserId`.
- It deviates from the explicit phase plan.

### Runtime Impact

No immediate runtime bug was found because the query references the implemented name.

This is still a gap because:

- It breaks plan-to-code traceability.
- It creates one exception in an otherwise consistent schema.
- Future code copied from the plan will fail until reconciled.
- It conflicts with the local Convex guideline: "Always include all index fields in the index name."

### Recommended Fix Direction

Use a small schema/code cleanup sequence.

Safest deployment sequence:

1. Add the correctly named index while keeping the existing index.
2. Update `convex/opportunities/listQueries.ts` to use the correctly named index.
3. Run Convex codegen/typecheck.
4. Deploy.
5. Remove the old index in a later cleanup after verifying no references remain.

Example schema patch:

```ts
.index("by_tenantId_and_assignedCloserId_and_source_and_status_and_latestActivityAt", [
  "tenantId",
  "assignedCloserId",
  "source",
  "status",
  "latestActivityAt",
])
```

Example query patch:

```ts
return ctx.db.query("opportunities").withIndex(
  "by_tenantId_and_assignedCloserId_and_source_and_status_and_latestActivityAt",
  (q) => {
    const query = q
      .eq("tenantId", args.tenantId)
      .eq("assignedCloserId", closerId)
      .eq("source", source)
      .eq("status", status);
    ...
  },
);
```

### Acceptance Criteria To Close

- Correctly named index exists.
- Query references use the correctly named index.
- Old index name is removed or explicitly documented as intentionally retained.
- `rg "by_tenantId_closerId_source_status_latestActivityAt"` returns no active query references.
- Convex codegen/typecheck passes.

## Additional Phase-by-Phase Analysis

This section documents areas that were reviewed and did not produce primary gaps, plus residual notes that matter when closing the four main gaps.

### Phase 1 Additional Notes

Implemented correctly:

- `source` remains optional during rollout.
- `latestActivityAt` remains optional during rollout.
- `manualCreationKey` is optional permanently.
- New side-deal origins are in payment origin validators.
- Runtime helpers normalize legacy missing source to `calendly`.
- Calendly opportunity creation writes `source: "calendly"` and `latestActivityAt`.
- Manual opportunity creation writes `source: "side_deal"` and `latestActivityAt`.
- The future narrow deploy is documented but not merged.

Key code examples:

```ts
source: v.optional(
  v.union(v.literal("calendly"), v.literal("side_deal")),
),
manualCreationKey: v.optional(v.string()),
latestActivityAt: v.optional(v.number()),
```

```ts
if (opportunity.source === undefined) {
  patch.source = "calendly";
}

if (opportunity.latestActivityAt === undefined) {
  patch.latestActivityAt = computeLatestActivityAt(opportunity);
}
```

Deviations:

- One index is correctly shaped but incorrectly named.
- Production backfill verification is not proven.

### Phase 2 Additional Notes

Implemented correctly:

- `createManual` is idempotent by tenant and request ID.
- Admins must provide an active closer.
- Closers cannot create on behalf of another closer.
- Manual opportunities are `source: "side_deal"` and `status: "in_progress"`.
- `logPayment` rejects Calendly opportunities.
- `logPayment` writes payment rows with `meetingId: undefined`.
- `markLost` rejects Calendly opportunities and enforces closer ownership.
- Events are emitted for creation, payment, and lost actions.

Key code examples:

```ts
const existingByRequest = await ctx.db
  .query("opportunities")
  .withIndex("by_tenantId_and_manualCreationKey", (q) =>
    q.eq("tenantId", tenantId).eq("manualCreationKey", manualCreationKey),
  )
  .unique();
```

```ts
if (!isSideDeal(opportunity)) {
  throw new Error("This mutation only accepts side-deal opportunities.");
}
```

Deviations:

- Manual creation does not reject non-convertible resolved leads.
- Search query can miss valid filtered results.

### Phase 3 Additional Notes

Implemented correctly:

- Opportunities page exists at `/workspace/opportunities`.
- Page uses the established thin RSC plus client component pattern.
- `unstable_instant = false` is used.
- `useSearchParams` is inside the client component rendered under Suspense from the page.
- List mode uses `usePaginatedQuery`.
- Initial page size is 25.
- Filters are persisted in URL state.
- Rows open canonical opportunity detail pages in a new tab with `noopener,noreferrer`.
- Admins get closer column/filter behavior.
- Navigation and command palette include Opportunities.

Key code examples:

```tsx
usePaginatedQuery(
  api.opportunities.listQueries.listOpportunities,
  isSearching ? "skip" : queryArgs,
  { initialNumItems: 25 },
);
```

Deviation:

- Search mode swaps to a different backend semantic that can omit valid filtered rows.

### Phase 4 Additional Notes

Implemented correctly:

- Full-page create form exists.
- Existing/new lead modes exist.
- Zod and React Hook Form are used.
- Admin closer picker exists.
- `?leadId=` prefill path exists.
- Stable `clientRequestId` supports idempotency.
- Submit redirects to detail and shows toast/PostHog behavior.
- Backend is authoritative for idempotency and closer assignment.

Residual risk:

- Existing lead and identity resolution flows can attach to non-convertible leads. This is Gap 2.

### Phase 5 Additional Notes

Implemented correctly:

- Detail route performs server preflight through `fetchQuery`.
- Detail query enforces tenant and closer access.
- Side-deal opportunities show record payment / mark lost actions only while in progress.
- Calendly opportunities do not get side-deal payment actions.
- Side-deal meetings section can be empty.
- Payment form calls `api.sideDeals.logPayment.logPayment`.
- Mark lost calls `api.sideDeals.markLost.markLost`.
- Payments list labels side-deal origins.
- Section error boundaries are present around major detail sections.
- Pipeline rows route to canonical opportunity detail.

Residual risk:

- If Gap 2 is not fixed, detail can present a record payment action for an opportunity that was invalidly created against a non-convertible lead. Backend rollback prevents payment corruption, but the workflow still fails late.

### Phase 6 Additional Notes

Implemented correctly:

- `voidPayment` is admin-only.
- It rejects already disputed payments.
- It rejects non-side-deal payment origins.
- It rejects payments not attached to opportunities.
- It verifies the opportunity is side-deal and currently `payment_received`.
- It patches payment to `disputed`.
- It moves the opportunity to `lost` locally rather than widening the global status transition map.
- It reverses payment stats and aggregates.
- It rolls back customer conversion if empty.
- Revenue origin labels exist for `closer_side_deal` and `admin_side_deal`.

Key code example:

```ts
if (!isSideDealOrigin(payment.origin)) {
  throw new Error("Only side-deal payments can be voided via this mutation.");
}
```

Justified deviation:

- The global status transition map does not need to allow `payment_received -> lost`. Keeping that exception local to `voidPayment` matches the design's safety note.

### Phase 7 Additional Notes

Implemented correctly:

- `followUps.reason` includes `stale_opportunity_nudge`.
- `by_opportunityId_and_status_and_reason` index exists.
- Staleness job scans side-deal in-progress opportunities older than 72 hours.
- Staleness job uses a paginated indexed query.
- It skips opportunities with payments, meetings, pending stale nudges, or real follow-ups.
- Stale reminder clicks route to opportunity detail.
- Generic reminder outcome actions are hidden for stale nudges.
- Payment and lost flows expire pending stale nudges.
- Delete mutation hard-deletes only empty side-deal in-progress opportunities.
- Delete mutation rechecks safety server-side.

Key code example:

```ts
const page = await ctx.db
  .query("opportunities")
  .withIndex("by_source_and_status_and_createdAt", (q) =>
    q
      .eq("source", "side_deal")
      .eq("status", "in_progress")
      .lt("createdAt", cutoff),
  )
  .order("asc")
  .paginate({ numItems: BATCH_SIZE, cursor: args.cursor ?? null });
```

Justified design point:

- `deleteEmptyOpportunity` does not delete the lead. The design explicitly keeps leads alive because lead identity and deduplication assumptions are separate from opportunity cleanup.

## Cross-Cutting Recommendations

### Add Regression Tests Around The Two Runtime Gaps

The highest value tests are not UI snapshots. They are backend behavior tests or seeded Convex smoke tests that prove the invariants:

- Search does not produce false negatives under filters.
- Manual creation cannot create unpayable opportunities.
- Lead picker and backend eligibility agree.
- Production backfill can be verified.

Suggested test cases:

```ts
describe("side-deal opportunity search", () => {
  it("finds a matching opportunity after more than 25 matching leads");
  it("finds a matching opportunity after more than 10 opportunities on the same lead");
  it("preserves closer scoping for closer users");
  it("preserves source/status/period filters in search mode");
});
```

```ts
describe("manual side-deal lead eligibility", () => {
  it("rejects an existing converted lead");
  it("rejects a new lead input that resolves to a converted lead");
  it("allows active lead creation and payment conversion");
  it("excludes non-active leads from the create-opportunity picker");
});
```

### Keep Backend Checks Authoritative

For all fixes, UI should improve the workflow but never be the only guard.

Examples:

- Filter converted leads out of the picker, but still reject them in `createManual`.
- Hide payment action in detail when possible, but still reject invalid status/source in `logPayment`.
- Hide delete action based on detail permissions, but still recheck payments/meetings/follow-ups in `deleteEmptyOpportunity`.

This matches the existing architecture and should not be weakened.

### Avoid Narrowing Schema Until Proof Exists

Do not make `opportunities.source` or `opportunities.latestActivityAt` required until:

- Production migration has run.
- Production verification is recorded.
- New writers have been smoke tested in production.
- Any legacy rows created during the migration window have been accounted for.

### Prefer Projection For Opportunity Search

The search bug is not just a missing `.take()` value. Raising the cap from 25 to 100 or 10 to 50 only changes where the false negative appears.

The correct long-term design is to search an opportunity-shaped dataset. That can be:

- A full-text opportunity projection.
- A tokenized opportunity projection.
- A future external search service if Convex search/index constraints are too limiting.

The current lead-first query should be treated as a temporary implementation.

## Suggested Closeout Order

1. Fix Gap 1: search correctness.
   - This is the only P1.
   - It directly affects whether users can find real records.
   - It may require schema/projection work, so plan migration/backfill if needed.

2. Fix Gap 2: manual side-deal lead eligibility.
   - This is a small backend guard with meaningful workflow impact.
   - Add UI filtering after backend enforcement.

3. Close Gap 3: production backfill verification.
   - Add verification helper.
   - Run production dry run, migration, and verification.
   - Record outputs.

4. Close Gap 4: index name cleanup.
   - Low runtime risk.
   - Good cleanup once higher-risk work is complete.

## Release Gate Recommendation

Do not mark all side-deals phases fully complete until:

- Search cannot silently miss valid filtered rows.
- Manual side-deal creation cannot produce opportunities that fail the payment path due to lead conversion eligibility.
- Production backfill verification is recorded.
- The index name mismatch is either corrected or explicitly accepted as a documented deviation.

## Final Finding List

### P1: Search can silently miss matching opportunities

File:

- `convex/opportunities/listQueries.ts:384-432`

Summary:

The search path caps matching leads at 25 and caps opportunities per lead at 10 before applying source/status/period/closer filters. Search mode can therefore omit valid opportunities that list mode would include.

### P2: Manual side deals can be created for leads that cannot convert

File:

- `convex/opportunities/createManual.ts:37-50`

Summary:

Manual creation accepts any tenant lead except unresolved merged records. New lead identity resolution can also return converted leads. The payment path later requires conversion to customer and rejects non-active leads, causing a late workflow failure.

### P2: Production backfill verification is not proven

File:

- `plans/side-deals/migration-notes.md:33-58`

Summary:

Dev migration proof exists, but production dry-run, production execution, and production verification output are not recorded. The schema is correctly still widened, but the migration phase cannot be considered fully closed.

### P3: Schema index name deviates from plan and Convex guidance

File:

- `convex/schema.ts:354-363`

Summary:

The index fields are correct, but the implemented index name does not match the planned name or field-based naming convention. Runtime works today because the query uses the implemented name, but the schema contract deviates from the plan.
