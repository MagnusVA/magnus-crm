# Phase 2 — Backend: Lead Queries

**Goal:** Create `convex/leads/queries.ts` with four queries (`listLeads`, `searchLeads`, `getLeadDetail`, `getMergePreview`) that power the Lead Manager frontend. After this phase, all read operations for the lead list page, lead detail page, and merge preview page are available as reactive Convex queries.

**Prerequisite:** Phase 1 complete (schema deployed with `leadMergeHistory` table, `searchText` field on `leads`, `by_tenantId_and_status` index, `search_leads` search index, `searchTextBuilder` utility, and `lead:*` permissions registered in `convex/lib/permissions.ts`).

**Runs in PARALLEL with:** Phase 3 (Backend -- Lead Mutations & Merge Logic). Phases 2 and 3 are separate files in the same `convex/leads/` directory (`queries.ts` and `mutations.ts`). They share no imports between each other and can be implemented simultaneously.

**Skills to invoke:**
- `convex-performance-audit` -- Review query read costs after implementation. Particular attention to `getLeadDetail` which fans out across 5 tables.

**Acceptance Criteria:**

1. `convex/leads/queries.ts` exists with all four exported queries: `listLeads`, `searchLeads`, `getLeadDetail`, `getMergePreview`.
2. All queries call `requireTenantUser(ctx, ["tenant_master", "tenant_admin", "closer"])` -- all roles have `lead:view-all` access. Exception: `getMergePreview` uses all three roles since `lead:merge` includes closer.
3. `listLeads` returns paginated results using `paginationOptsValidator`, enriched with `opportunityCount`, `latestMeetingAt`, and `assignedCloserName`.
4. `searchLeads` uses the `search_leads` search index, returns at most 20 results, and filters out merged leads by default.
5. `getLeadDetail` returns `{ redirectToLeadId, lead, identifiers, opportunities, meetings, followUps, mergeHistory }` and handles merged-lead redirects.
6. `getMergePreview` returns side-by-side comparison with identifier diff (`identifiersToMove`, `duplicateIdentifiers`) and opportunity counts. Rejects already-merged leads.
7. All queries use `.withIndex()` -- no `.filter()` calls.
8. All queries return bounded results (`.take(N)`, `.paginate()`, `.first()`, or `.unique()`).
9. Structured logging with `[Leads:List]`, `[Leads:Search]`, `[Leads:Detail]`, `[Leads:MergePreview]` tags at key decision points.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (listLeads) ────────────────────┐
                                    │
2B (searchLeads) ──────────────────┤── All write to convex/leads/queries.ts
                                    │   (same file, but independent query exports)
2C (getLeadDetail) ────────────────┤
                                    │
2D (getMergePreview) ──────────────┘
```

**Optimal execution:**

1. Start **2A**, **2B**, **2C**, and **2D** all in parallel -- they are independent query exports in the same file with no cross-dependencies. Create the file with shared imports in the first subphase you implement, then append the remaining queries.
2. After all four are complete, run `pnpm tsc --noEmit` and verify.

**Estimated time:** 2-4 hours

---

## Subphases

### 2A -- `listLeads` Query (Paginated Lead List)

**Type:** Backend
**Parallelizable:** Yes -- independent query export. No dependency on 2B, 2C, or 2D. Creates the shared file with imports.

**What:** Paginated query returning leads for the current tenant with optional status filter, enriched with opportunity count, latest meeting date, and assigned closer name. Used by the lead list page (`/workspace/leads`).

**Why:** The lead list page needs paginated, enriched data. Pagination is essential because lead volumes grow unboundedly. Enrichment (opportunity count, latest meeting, closer name) avoids N+1 queries on the client. The cost of server-side enrichment is bounded by page size (25 items) and opportunity cap (`.take(50)` per lead).

**Where:**
- `convex/leads/queries.ts` (new)

**How:**

**Step 1: Create the file with shared imports and the `listLeads` query**

```typescript
// Path: convex/leads/queries.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * List leads for the current tenant with pagination and optional status filter.
 *
 * All roles can view leads (lead:view-all includes closer).
 * Returns leads ordered by most recently created first (Convex default desc = newest _creationTime).
 *
 * Enrichment per lead:
 * - opportunityCount: number of opportunities linked to this lead
 * - latestMeetingAt: most recent meeting scheduledAt across all opportunities (denormalized)
 * - assignedCloserName: name of the closer assigned to the most recent opportunity
 */
export const listLeads = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(
      v.union(v.literal("active"), v.literal("converted"), v.literal("merged")),
    ),
  },
  handler: async (ctx, { paginationOpts, statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    let leadsQuery;
    if (statusFilter) {
      leadsQuery = ctx.db
        .query("leads")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", statusFilter),
        )
        .order("desc");
    } else {
      // Default: all non-merged leads. We query all leads for the tenant
      // and post-filter merged ones. This is acceptable because pagination
      // bounds the result set and merged leads are a small minority.
      leadsQuery = ctx.db
        .query("leads")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .order("desc");
    }

    const results = await leadsQuery.paginate(paginationOpts);

    // Post-filter merged leads when no explicit status filter is set.
    // Pagination cursor remains valid because we don't skip pages.
    const filteredPage =
      statusFilter === undefined
        ? results.page.filter((lead) => lead.status !== "merged")
        : results.page;

    // Enrich each lead with opportunity count, latest meeting date, and closer name.
    // Cost: bounded by page size (default 25) * opportunities per lead (.take(50)).
    // Closer lookups are deduplicated via ctx.db.get() cache within a single query.
    const enrichedPage = await Promise.all(
      filteredPage.map(async (lead) => {
        const opportunities = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", lead._id),
          )
          .take(50);

        let latestMeetingAt: number | null = null;
        let assignedCloserName: string | null = null;

        for (const opp of opportunities) {
          // Use denormalized latestMeetingAt from opportunity for efficiency
          if (opp.latestMeetingAt) {
            if (!latestMeetingAt || opp.latestMeetingAt > latestMeetingAt) {
              latestMeetingAt = opp.latestMeetingAt;
            }
          }
          // Get the most recently assigned closer (first non-null wins, desc order)
          if (opp.assignedCloserId && !assignedCloserName) {
            const closer = await ctx.db.get(opp.assignedCloserId);
            if (closer && closer.tenantId === tenantId) {
              assignedCloserName = closer.fullName ?? closer.email;
            }
          }
        }

        return {
          ...lead,
          opportunityCount: opportunities.length,
          latestMeetingAt,
          assignedCloserName,
        };
      }),
    );

    console.log("[Leads:List] listLeads completed", {
      tenantId,
      statusFilter: statusFilter ?? "default (non-merged)",
      pageSize: enrichedPage.length,
      isDone: results.isDone,
    });

    return {
      ...results,
      page: enrichedPage,
    };
  },
});
```

**Key implementation notes:**

- **Index selection:** When `statusFilter` is provided, uses `by_tenantId_and_status` for a precise range scan. When no filter is set, falls back to `by_tenantId` and post-filters merged leads. This avoids needing a compound query across multiple status values (Convex does not support `OR` in index range expressions).
- **Enrichment cost:** For a 25-item page, the worst case is 25 leads * 50 opportunities = 1,250 opportunity reads + up to 25 closer reads (one per lead, deduplicated by `ctx.db.get` cache). This is well within Convex query limits (16MB bandwidth, 8 seconds timeout).
- **Denormalized `latestMeetingAt`:** Uses the opportunity's `latestMeetingAt` field (maintained by `updateOpportunityMeetingRefs()`) rather than querying meetings directly. This avoids a second fan-out per opportunity.
- **Closer deduplication:** `ctx.db.get()` is cached within a single Convex function execution. If multiple opportunities share the same `assignedCloserId`, the closer document is fetched only once.
- **Post-filtering merged leads:** When no `statusFilter` is set, merged leads are filtered out after pagination. This means a page could have fewer than `numItems` results if some leads in the page range are merged. In practice, merged leads are a small minority, so this is acceptable. The alternative (a multi-status index query) is not possible in Convex.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Create | `listLeads` query with pagination, status filter, and enrichment |

---

### 2B -- `searchLeads` Query (Full-Text Search)

**Type:** Backend
**Parallelizable:** Yes -- independent query export. No dependency on 2A, 2C, or 2D.

**What:** Full-text search query using the `search_leads` search index on the denormalized `searchText` field. Returns up to 20 results ranked by Convex's built-in relevance scoring. Filters out merged leads by default.

**Why:** The lead list page has a search bar that needs sub-second full-text results across name, email, phone, and social handles. The search index on the denormalized `searchText` field (built by `searchTextBuilder.ts` in Phase 1) enables this. The merge page also uses this query to let the user search for a target lead.

**Where:**
- `convex/leads/queries.ts` (append to existing file)

**How:**

**Step 1: Add the `searchLeads` query**

```typescript
// Path: convex/leads/queries.ts (appended after listLeads)

/**
 * Search leads by name, email, phone, or social handle.
 *
 * Uses the search_leads search index on the denormalized searchText field.
 * Returns up to 20 results ranked by relevance.
 * Filters out merged leads by default unless statusFilter is explicitly "merged".
 *
 * Used by:
 * - Lead list page search bar
 * - Merge page target lead search
 */
export const searchLeads = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(
      v.union(v.literal("active"), v.literal("converted"), v.literal("merged")),
    ),
  },
  handler: async (ctx, { searchTerm, statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const trimmed = searchTerm.trim();
    if (trimmed.length === 0) {
      console.log("[Leads:Search] empty search term, returning []", { tenantId });
      return [];
    }

    const searchQuery = ctx.db
      .query("leads")
      .withSearchIndex("search_leads", (q) => {
        const base = q.search("searchText", trimmed).eq("tenantId", tenantId);
        if (statusFilter) {
          return base.eq("status", statusFilter);
        }
        return base;
      });

    const results = await searchQuery.take(20);

    // Filter out merged leads from default search (unless explicitly searching for merged)
    const filtered = statusFilter
      ? results
      : results.filter((lead) => lead.status !== "merged");

    console.log("[Leads:Search] searchLeads completed", {
      tenantId,
      searchTerm: trimmed,
      statusFilter: statusFilter ?? "default (non-merged)",
      resultCount: filtered.length,
      rawResultCount: results.length,
    });

    return filtered;
  },
});
```

**Key implementation notes:**

- **Search index filter fields:** The `search_leads` index has `filterFields: ["tenantId", "status"]`. When `statusFilter` is provided, both filters are applied at the index level (zero post-filtering cost). When no filter is set, `tenantId` is applied at the index level and `status !== "merged"` is post-filtered in JavaScript on at most 20 results.
- **Empty search guard:** Returns `[]` immediately for empty/whitespace-only search terms. This avoids an unnecessary search index scan and prevents Convex from throwing on empty search queries.
- **Result cap:** `.take(20)` bounds the result set. Search results beyond 20 are not useful in a typeahead/search context. If the UI needs more, increase this constant.
- **No enrichment:** Unlike `listLeads`, search results return raw lead documents without enrichment. The search UI shows minimal lead info (name, email, status) and enrichment would add unnecessary read cost for a typeahead interaction. The detail page (`getLeadDetail`) provides full enrichment when the user clicks a result.
- **Merge page usage:** The merge page's target lead search reuses this query. The caller can pass `statusFilter: "active"` to exclude converted and merged leads from merge target selection.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Append `searchLeads` query |

---

### 2C -- `getLeadDetail` Query (Full Lead Profile)

**Type:** Backend
**Parallelizable:** Yes -- independent query export. No dependency on 2A, 2B, or 2D.

**What:** Single query returning everything needed for the 5-tab lead detail page: the lead document, all identifiers, enriched opportunities (with closer name and event type), all meetings across all opportunities (sorted chronologically), all follow-ups, and full merge history (as source or target). Handles merged-lead redirects by returning `redirectToLeadId` instead of the full profile.

**Why:** The lead detail page (`/workspace/leads/[leadId]`) has 5 tabs (Overview, Meetings, Opportunities, Activity, Custom Fields) that all need data. A single reactive query ensures all tabs stay in sync when data changes (e.g., a new meeting is booked, a merge is executed). The alternative -- separate queries per tab -- would create multiple subscriptions and potential inconsistency between tabs.

**Where:**
- `convex/leads/queries.ts` (append to existing file)

**How:**

**Step 1: Add the `getLeadDetail` query**

```typescript
// Path: convex/leads/queries.ts (appended after searchLeads)

/**
 * Get complete lead detail for the 5-tab detail page.
 *
 * Returns:
 * - redirectToLeadId: non-null if this lead was merged (client should redirect)
 * - lead: Core lead document
 * - identifiers: All leadIdentifier records for this lead
 * - opportunities: All opportunities with enrichment (closer name, event type name)
 * - meetings: All meetings across all opportunities (sorted by scheduledAt desc)
 * - followUps: All follow-ups for this lead
 * - mergeHistory: All merge events involving this lead (as source or target)
 *
 * If the lead has status "merged" and a valid mergedIntoLeadId, returns
 * { redirectToLeadId: <targetLeadId> } with all other fields empty.
 * The client renders a redirect or "This lead was merged into X" message.
 */
export const getLeadDetail = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) {
      throw new Error("Lead not found");
    }

    // Handle merged lead redirect: follow the merge chain to the active lead
    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const targetLead = await ctx.db.get(lead.mergedIntoLeadId);
      if (targetLead && targetLead.tenantId === tenantId) {
        console.log("[Leads:Detail] merged lead redirect", {
          sourceLeadId: leadId,
          targetLeadId: targetLead._id,
        });
        return {
          redirectToLeadId: targetLead._id,
          lead: null,
          identifiers: [],
          opportunities: [],
          meetings: [],
          followUps: [],
          mergeHistory: [],
        };
      }
      // If target lead is missing or cross-tenant, fall through and show the merged lead as-is.
      // This is a data integrity edge case -- log it for investigation.
      console.error("[Leads:Detail] merged lead target not found or cross-tenant", {
        sourceLeadId: leadId,
        mergedIntoLeadId: lead.mergedIntoLeadId,
        targetFound: !!targetLead,
        targetTenantMatch: targetLead?.tenantId === tenantId,
      });
    }

    // --- Load all related data in parallel where possible ---

    // 1. Identifiers
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .take(100);

    // 2. Opportunities with enrichment
    const rawOpportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .take(50);

    const opportunities = await Promise.all(
      rawOpportunities.map(async (opp) => {
        let closerName: string | null = null;
        if (opp.assignedCloserId) {
          const closer = await ctx.db.get(opp.assignedCloserId);
          if (closer && closer.tenantId === tenantId) {
            closerName = closer.fullName ?? closer.email;
          }
        }

        let eventTypeName: string | null = null;
        if (opp.eventTypeConfigId) {
          const config = await ctx.db.get(opp.eventTypeConfigId);
          eventTypeName = config?.displayName ?? null;
        }

        return {
          ...opp,
          closerName,
          eventTypeName,
        };
      }),
    );

    // 3. Meetings across all opportunities
    const allMeetings: Array<{
      _id: typeof leadId; // Id<"meetings"> -- using typeof for structural match
      _creationTime: number;
      tenantId: typeof tenantId;
      opportunityId: (typeof rawOpportunities)[number]["_id"];
      calendlyEventUri: string;
      calendlyInviteeUri: string;
      scheduledAt: number;
      durationMinutes: number;
      status: string;
      notes?: string;
      leadName?: string;
      createdAt: number;
      opportunityStatus: string;
      closerName: string | null;
      [key: string]: unknown;
    }> = [];

    for (const opp of rawOpportunities) {
      const oppMeetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
        .take(50);

      // Reuse the closer name already resolved during opportunity enrichment
      const enrichedOpp = opportunities.find((o) => o._id === opp._id);
      const closerName = enrichedOpp?.closerName ?? null;

      for (const mtg of oppMeetings) {
        allMeetings.push({
          ...mtg,
          opportunityStatus: opp.status,
          closerName,
        });
      }
    }

    // Sort meetings by scheduledAt descending (most recent first)
    allMeetings.sort((a, b) => b.scheduledAt - a.scheduledAt);

    // 4. Follow-ups for this lead
    // followUps table has by_tenantId index but no by_leadId index.
    // Query by tenant and filter by leadId in JavaScript.
    // Bounded by .take(200) on the tenant query.
    const tenantFollowUps = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200);
    const leadFollowUps = tenantFollowUps.filter((fu) => fu.leadId === leadId);

    // 5. Merge history (as source or target)
    const mergeHistoryAsSource = await ctx.db
      .query("leadMergeHistory")
      .withIndex("by_sourceLeadId", (q) => q.eq("sourceLeadId", leadId))
      .take(20);

    const mergeHistoryAsTarget = await ctx.db
      .query("leadMergeHistory")
      .withIndex("by_targetLeadId", (q) => q.eq("targetLeadId", leadId))
      .take(20);

    // Enrich merge history with user names
    const mergeHistory = await Promise.all(
      [...mergeHistoryAsSource, ...mergeHistoryAsTarget]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (entry) => {
          const mergedByUser = await ctx.db.get(entry.mergedByUserId);
          const sourceLeadDoc =
            entry.sourceLeadId === leadId
              ? lead
              : await ctx.db.get(entry.sourceLeadId);
          const targetLeadDoc =
            entry.targetLeadId === leadId
              ? lead
              : await ctx.db.get(entry.targetLeadId);

          return {
            ...entry,
            mergedByUserName: mergedByUser?.fullName ?? mergedByUser?.email ?? "Unknown",
            sourceLeadName: sourceLeadDoc?.fullName ?? sourceLeadDoc?.email ?? "Unknown",
            targetLeadName: targetLeadDoc?.fullName ?? targetLeadDoc?.email ?? "Unknown",
          };
        }),
    );

    console.log("[Leads:Detail] getLeadDetail completed", {
      leadId,
      identifierCount: identifiers.length,
      opportunityCount: opportunities.length,
      meetingCount: allMeetings.length,
      followUpCount: leadFollowUps.length,
      mergeHistoryCount: mergeHistory.length,
    });

    return {
      redirectToLeadId: null,
      lead,
      identifiers,
      opportunities,
      meetings: allMeetings,
      followUps: leadFollowUps,
      mergeHistory,
    };
  },
});
```

**Key implementation notes:**

- **Merged lead redirect:** When a lead has `status === "merged"`, the query returns `{ redirectToLeadId: targetLeadId }` with all other fields empty. The client component checks `redirectToLeadId` and either redirects with `router.replace()` or shows a "This lead was merged into X" banner. This pattern avoids loading unnecessary data for merged leads.
- **Merge chain depth:** Only one level of redirection is followed. If a lead was merged into another lead that was also merged (chain: A -> B -> C), the query returns B's ID, not C's. The client follows the chain iteratively. This avoids unbounded recursion in the query and keeps the redirect logic simple. In practice, multi-level merge chains are rare.
- **Follow-up loading strategy:** The `followUps` table has no `by_leadId` index -- only `by_tenantId` and `by_opportunityId`. We use `by_tenantId` with `.take(200)` and filter by `leadId` in JavaScript. This is the design doc's specified approach. If follow-up volumes grow, add a `by_leadId` index in a future migration.
- **Meeting enrichment reuse:** The closer name resolved during opportunity enrichment is reused for meetings within the same opportunity, avoiding duplicate `ctx.db.get()` calls. Since `ctx.db.get()` is cached within a query execution, this is a readability optimization rather than a performance one.
- **Merge history enrichment:** Each merge history entry is enriched with the names of the merged-by user, source lead, and target lead. The current lead document is reused (not re-fetched) when it matches the source or target ID.
- **Read cost analysis:** For a lead with 5 opportunities, 10 meetings, 3 identifiers, and 2 merge events, the approximate read count is: 1 (lead) + 100 (identifiers cap) + 50 (opportunities cap) + 5 (closer lookups) + 5 (event type lookups) + 50 (meetings cap per opp, 5 opps) + 200 (follow-ups cap) + 40 (merge history cap) + merge enrichment lookups. Worst case is under 500 document reads, well within Convex limits.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Append `getLeadDetail` query |

---

### 2D -- `getMergePreview` Query (Merge Preview)

**Type:** Backend
**Parallelizable:** Yes -- independent query export. No dependency on 2A, 2B, or 2C.

**What:** Takes `sourceLeadId` and `targetLeadId`, validates neither is already merged, and returns a side-by-side comparison with identifier diff (which identifiers are new to the target, which are duplicates) and opportunity counts. Used by the merge page (`/workspace/leads/[leadId]/merge`) to show the user what will happen before they confirm.

**Why:** Merge is irreversible in the UI. The preview query lets the user see exactly what will be moved (opportunities, identifiers) and what is redundant (duplicate identifiers already on the target). This reduces merge errors and builds confidence. The preview is a read-only query, not a mutation -- it can be called reactively as the user selects different target leads.

**Where:**
- `convex/leads/queries.ts` (append to existing file)

**How:**

**Step 1: Add the `getMergePreview` query**

```typescript
// Path: convex/leads/queries.ts (appended after getLeadDetail)

/**
 * Preview what a merge would do before executing.
 * Shows side-by-side comparison of source and target leads with identifier diff
 * and opportunity counts.
 *
 * Convention:
 * - "source" = the lead being absorbed (will become status: "merged" after merge)
 * - "target" = the surviving lead that receives all data
 *
 * All roles with lead:merge permission can preview (tenant_master, tenant_admin, closer).
 * Rejects already-merged leads on either side.
 */
export const getMergePreview = query({
  args: {
    sourceLeadId: v.id("leads"),
    targetLeadId: v.id("leads"),
  },
  handler: async (ctx, { sourceLeadId, targetLeadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    // Validate both leads exist and belong to this tenant
    const source = await ctx.db.get(sourceLeadId);
    const target = await ctx.db.get(targetLeadId);

    if (!source || source.tenantId !== tenantId) {
      throw new Error("Source lead not found");
    }
    if (!target || target.tenantId !== tenantId) {
      throw new Error("Target lead not found");
    }
    if (source.status === "merged") {
      throw new Error("Source lead is already merged");
    }
    if (target.status === "merged") {
      throw new Error("Target lead is already merged");
    }
    if (sourceLeadId === targetLeadId) {
      throw new Error("Cannot merge a lead into itself");
    }

    // Load identifiers for both leads
    const sourceIdentifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", sourceLeadId))
      .take(100);

    const targetIdentifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", targetLeadId))
      .take(100);

    // Load opportunity counts for both leads
    const sourceOpportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", sourceLeadId),
      )
      .take(50);

    const targetOpportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", targetLeadId),
      )
      .take(50);

    // Compute identifier diff: which source identifiers are new to the target,
    // and which already exist on the target (duplicates).
    const targetIdSet = new Set(
      targetIdentifiers.map((i) => `${i.type}:${i.value}`),
    );
    const newIdentifiers = sourceIdentifiers.filter(
      (i) => !targetIdSet.has(`${i.type}:${i.value}`),
    );
    const duplicateIdentifiers = sourceIdentifiers.filter((i) =>
      targetIdSet.has(`${i.type}:${i.value}`),
    );

    console.log("[Leads:MergePreview] getMergePreview completed", {
      sourceLeadId,
      targetLeadId,
      sourceIdentifierCount: sourceIdentifiers.length,
      targetIdentifierCount: targetIdentifiers.length,
      newIdentifierCount: newIdentifiers.length,
      duplicateIdentifierCount: duplicateIdentifiers.length,
      sourceOpportunityCount: sourceOpportunities.length,
      targetOpportunityCount: targetOpportunities.length,
    });

    return {
      source: {
        lead: source,
        identifiers: sourceIdentifiers,
        opportunityCount: sourceOpportunities.length,
      },
      target: {
        lead: target,
        identifiers: targetIdentifiers,
        opportunityCount: targetOpportunities.length,
      },
      preview: {
        identifiersToMove: newIdentifiers.length,
        duplicateIdentifiers: duplicateIdentifiers.length,
        opportunitiesToMove: sourceOpportunities.length,
        totalOpportunitiesAfterMerge:
          sourceOpportunities.length + targetOpportunities.length,
      },
    };
  },
});
```

**Key implementation notes:**

- **Self-merge guard:** The query rejects `sourceLeadId === targetLeadId` with a descriptive error. This is a cheap client-side mistake to catch early rather than letting it propagate to the merge mutation.
- **Already-merged guard:** Both source and target are checked for `status === "merged"`. A merged lead cannot be a merge source (it has no data left to move) or a merge target (it is a dead pointer). The merge mutation in Phase 3 will re-validate these conditions transactionally.
- **Identifier diff:** The `type:value` composite key is used to determine uniqueness. Two identifiers with the same type and normalized value are considered duplicates even if they have different `rawValue`, `source`, or `confidence` fields. During the actual merge (Phase 3), duplicate source identifiers are skipped (not moved).
- **Read cost:** 2 lead reads + up to 200 identifier reads (100 per lead) + up to 100 opportunity reads (50 per lead). Total: ~302 document reads. This is lightweight and appropriate for a reactive query that re-runs when either lead changes.
- **No enrichment on identifiers:** The full identifier documents are returned (including `type`, `value`, `rawValue`, `source`, `confidence`, `createdAt`) so the merge preview UI can display a rich comparison table. No additional enrichment is needed.
- **Role access:** All three roles have `lead:merge` permission per the design doc. Closers are the primary merge actors.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Append `getMergePreview` query |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leads/queries.ts` | Create | 2A (creates file), 2B, 2C, 2D (append) |

---

## Notes for Implementer

- **Directory creation:** Phase 1 creates the `convex/leads/` directory with `searchTextBuilder.ts`. If implementing Phase 2 before Phase 1 is fully complete, ensure the directory exists (`mkdir -p convex/leads`).
- **No `"use node"` directive:** All four queries are pure Convex queries with no Node.js dependencies. Do not add `"use node"` to this file.
- **Public queries, not internal:** All four queries use `query` (not `internalQuery`) because they are called from the client via `useQuery(api.leads.queries.listLeads, ...)`. The `requireTenantUser` guard provides authentication and authorization.
- **Type inference:** The return types of all queries are inferred by TypeScript from the handler return statements. Do not add explicit return type annotations -- Convex's codegen handles the client-side type inference via the `api` object.
- **Follow-up index consideration:** `getLeadDetail` uses `.take(200)` on `followUps` filtered by `tenantId`, then post-filters by `leadId`. If a tenant accumulates hundreds of follow-ups, this becomes inefficient. Consider adding a `by_leadId` index to `followUps` in a future migration. The current approach matches the design doc and is acceptable for v0.5 volumes.
- **Parallel with Phase 3:** This file (`queries.ts`) and Phase 3's file (`mutations.ts`) are in the same directory but share no imports. They can be developed and deployed simultaneously. Both import from `../requireTenantUser` and `../_generated/server` but not from each other.
- **Performance audit:** After implementation, invoke the `convex-performance-audit` skill to review read costs. Key areas to audit: (1) `getLeadDetail` fan-out across 5 tables, (2) `listLeads` enrichment loop, (3) `getMergePreview` identifier diff on large identifier sets.
