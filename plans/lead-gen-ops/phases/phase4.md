# Phase 4 — Audit Matching to Qualified CRM Records

**Goal:** Add the one-way audit bridge from Lead Gen Ops prospects to later Slack-qualified CRM records and preserve that audit link when the Slack-qualified opportunity schedules through Calendly. After this phase, Lead Gen Ops can prove prior activity without changing CRM funnel creation, opportunity lifecycle, or conversion reporting.

**Prerequisite:** Phase 1 schema and role foundation complete. Phase 2 capture is required for end-to-end QA data, but Phase 4 backend helpers can start as soon as `leadGenProspects` and `leadGenAuditMatches` exist.

**Runs in PARALLEL with:** Phase 2 and Phase 3 after Phase 1. The Slack/Calendly integration files are Phase 4-owned and should not be edited by Phase 2 or Phase 3.

**Skills to invoke:**
- `convex` — internal mutations, scheduler usage, tenant-scoped indexed lookups, and no public audit write surface except admin corrections later.
- `convex-performance-audit` — verify bounded audit-match lookups and no cold-booking Lead Gen scans.
- `next-best-practices` — optional read-only display panels remain thin RSC/client boundaries.
- `shadcn` — audit badges, detail panels, tables, and skeletons if display surfaces are enabled.
- `frontend-design` — traceability UI must be quiet, read-only, and visually distinct from conversion metrics.
- `web-design-guidelines` — audit display labels, links, and table semantics.

**Acceptance Criteria:**
1. Slack qualification success paths can schedule `internal.leadGen.auditMatching.matchQualifiedLead` after the CRM lead/opportunity decision is made.
2. Slack modal, slash command ACK path, request signature handling, and response timing are unchanged.
3. `created_opportunity` and `duplicate_pending` paths create or reuse an accepted audit match when exactly one Lead Gen prospect matches the normalized Instagram handle.
4. `already_booked`, failed, or unlinked Slack qualification paths do not create accepted audit matches by default.
5. Audit matching never creates `leads`, `opportunities`, `meetings`, or Lead Gen prospects.
6. Calendly `invitee.created` does not search `leadGenProspects` for cold bookings.
7. Calendly scheduling of a Slack-qualified opportunity preserves an existing accepted audit match and fills `opportunityId` only when it is missing.
8. Ambiguous Lead Gen prospect or match data results in no accepted match; optional candidate rows remain review-only.
9. Optional CRM/Lead Gen display surfaces label the relationship as audit traceability and do not show conversion rates.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Audit helper) ───────────────┬── 4B (Slack qualification hook) ─────┐
                                 ├── 4C (Calendly preservation hook) ───┤
                                 └── 4D (Read-only display queries) ────┤
                                                                          ├── 4E (Audit UI surfaces)
Phase 2 seed capture data ───────────────────────────────────────────────┘

4B + 4C + 4E complete ───────────────── 4F (Slack/Calendly regression gate)
```

**Optimal execution:**
1. Build 4A first; both Slack and Calendly integration points import it.
2. Run 4B and 4C in parallel because they touch different integration files.
3. Build 4D/4E if MVP chooses to expose read-only traceability in UI; otherwise keep them behind a follow-up flag.
4. Finish with 4F, re-running existing Slack and Calendly QA paths.

**Estimated time:** 2 days without optional UI, 3 days with display surfaces.

---

## Subphases

### 4A — Internal Audit Matching Helper

**Type:** Backend  
**Parallelizable:** No — Slack and Calendly integration depend on this helper.

**What:** Implement `internal.leadGen.auditMatching.matchQualifiedLead` and `preserveQualificationAuditMatchForScheduledMeeting`.

**Why:** Matching must be internal, bounded, tenant-scoped, exact, and audit-only. Public clients should not be able to create accepted matches.

**Where:**
- `convex/leadGen/auditMatching.ts` (new)

**How:**

**Step 1: Add internal match mutation.**

```typescript
// Path: convex/leadGen/auditMatching.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id, Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeSocialHandle } from "../lib/normalization";
import {
  leadGenAuditMatchSourceValidator,
} from "./validators";

export const matchQualifiedLead = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    opportunityId: v.optional(v.id("opportunities")),
    platform: v.union(v.literal("instagram")),
    rawHandle: v.string(),
    matchSource: leadGenAuditMatchSourceValidator,
  },
  handler: async (ctx, args) => {
    const normalizedHandle = normalizeSocialHandle(
      args.rawHandle,
      args.platform,
    );
    if (!normalizedHandle) return null;

    const prospects = await ctx.db
      .query("leadGenProspects")
      .withIndex("by_tenantId_and_dedupeKey", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("dedupeKey", `instagram:${normalizedHandle}`),
      )
      .take(2);

    if (prospects.length !== 1) {
      return null;
    }

    return await createOrReuseAcceptedMatch(ctx, {
      ...args,
      prospect: prospects[0],
      normalizedHandle,
    });
  },
});
```

**Step 2: Reuse accepted matches and avoid conflicts.**

```typescript
// Path: convex/leadGen/auditMatching.ts
async function createOrReuseAcceptedMatch(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    prospect: Doc<"leadGenProspects">;
    leadId: Id<"leads">;
    opportunityId?: Id<"opportunities">;
    normalizedHandle: string;
    matchSource: Doc<"leadGenAuditMatches">["matchSource"];
  },
) {
  const existingMatches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_prospectId_and_leadId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("prospectId", args.prospect._id)
        .eq("leadId", args.leadId),
    )
    .take(2);

  const accepted = existingMatches.find(
    (match) => match.matchStatus === "accepted",
  );
  if (accepted) {
    if (!accepted.opportunityId && args.opportunityId) {
      await ctx.db.patch(accepted._id, {
        opportunityId: args.opportunityId,
        updatedAt: Date.now(),
      });
    }
    return accepted._id;
  }

  if (existingMatches.length > 1) {
    return null;
  }

  const now = Date.now();
  const matchId = await ctx.db.insert("leadGenAuditMatches", {
    tenantId: args.tenantId,
    prospectId: args.prospect._id,
    leadId: args.leadId,
    opportunityId: args.opportunityId,
    matchSource: args.matchSource,
    matchStatus: "accepted",
    matchedVia: "social_handle",
    normalizedHandle: args.normalizedHandle,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.patch(args.prospect._id, {
    currentAuditMatchId: matchId,
    updatedAt: now,
  });

  return matchId;
}
```

**Step 3: Add Calendly preservation helper as a plain mutation helper.**

```typescript
// Path: convex/leadGen/auditMatching.ts
export async function preserveQualificationAuditMatchForScheduledMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    opportunityId: Id<"opportunities">;
    now: number;
  },
) {
  const matches = await ctx.db
    .query("leadGenAuditMatches")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", args.leadId),
    )
    .take(5);

  const match = matches.find((row) => row.matchStatus === "accepted");
  if (!match) return null;
  if (match.opportunityId === args.opportunityId) return match._id;
  if (match.opportunityId !== undefined) return match._id;

  await ctx.db.patch(match._id, {
    opportunityId: args.opportunityId,
    updatedAt: args.now,
  });

  return match._id;
}
```

**Key implementation notes:**
- Exact one prospect is required for accepted matching. Zero or multiple prospects returns no accepted match.
- This helper does not validate auth because it is internal and called from trusted Slack/Calendly pipeline paths that already know `tenantId`.
- Do not use `.collect()` for audit matches; all lookups are bounded.
- Candidate rows are optional and should be added only if product wants a review queue.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/auditMatching.ts` | Create | Internal matching and preservation helpers |

---

### 4B — Slack Qualification Post-Success Hook

**Type:** Backend / Integration  
**Parallelizable:** Yes — depends on 4A and touches only the Slack qualification creation file.

**What:** Schedule audit matching from `convex/slack/createQualifiedLead.ts` after eligible successful qualification branches.

**Why:** Slack qualification remains the source of CRM qualification. Lead Gen Ops only attaches audit traceability after Slack has produced or found the trusted CRM record.

**Where:**
- `convex/slack/createQualifiedLead.ts` (modify)

**How:**

**Step 1: Import `internal` if not already available and add a local scheduler helper inside the mutation handler.**

```typescript
// Path: convex/slack/createQualifiedLead.ts
async function scheduleLeadGenAuditMatch(params: {
  resultKind: "created_opportunity" | "duplicate_pending" | "already_booked";
  leadId: Id<"leads">;
  opportunityId?: Id<"opportunities">;
}) {
  if (args.platform !== "instagram") return;
  if (params.resultKind === "already_booked") return;

  await ctx.scheduler.runAfter(
    0,
    internal.leadGen.auditMatching.matchQualifiedLead,
    {
      tenantId: args.tenantId,
      leadId: params.leadId,
      opportunityId: params.opportunityId,
      platform: "instagram",
      rawHandle: args.handle,
      matchSource: "slack_qualification",
    },
  );
}
```

**Step 2: Call before eligible return branches.**

```typescript
// Path: convex/slack/createQualifiedLead.ts
await scheduleLeadGenAuditMatch({
  resultKind: "created_opportunity",
  leadId: resolution.leadId,
  opportunityId,
});

return {
  kind: "created_opportunity",
  leadId: resolution.leadId,
  opportunityId,
};
```

```typescript
// Path: convex/slack/createQualifiedLead.ts
await scheduleLeadGenAuditMatch({
  resultKind: "duplicate_pending",
  leadId: existingLeadId,
  opportunityId: existingOpportunity._id,
});

return {
  kind: "duplicate_pending",
  leadId: existingLeadId,
  opportunityId: existingOpportunity._id,
};
```

**Step 3: Leave disallowed branches untouched except explicit no-op comments.**

```typescript
// Path: convex/slack/createQualifiedLead.ts
// Do not create accepted Lead Gen audit matches for already-booked results.
// The CRM record is no longer qualified-pending, and Lead Gen Ops remains
// audit-only rather than retroactive conversion attribution.
return {
  kind: "already_booked",
  leadId,
  opportunityId,
};
```

**Key implementation notes:**
- The hook is after qualification decisions, not in Slack HTTP handlers or modal parsing.
- Schedule before return branches so early returns do not skip eligible audit matching.
- If the scheduled internal mutation fails, Slack qualification should still be considered successful. Log failures inside the internal helper if needed.
- Do not broaden matching beyond Instagram in MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/createQualifiedLead.ts` | Modify | Add post-success audit scheduler only |

---

### 4C — Calendly Scheduled Qualification Preservation

**Type:** Backend / Integration  
**Parallelizable:** Yes — depends on 4A and touches only the Calendly invitee-created pipeline.

**What:** When Calendly joins an already Slack-qualified opportunity, preserve any existing accepted Lead Gen audit match for that lead/opportunity.

**Why:** Calendly is downstream for this feature. It must not discover Lead Gen prospects for cold bookings, but it should preserve an audit match that Slack qualification already accepted.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/leadGen/auditMatching.ts` (read helper)

**How:**

**Step 1: Import the preservation helper.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
import {
  preserveQualificationAuditMatchForScheduledMeeting,
} from "../leadGen/auditMatching";
```

**Step 2: Call only inside the existing Slack-qualified opportunity branch.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
if (slackQualifiedOpportunity) {
  opportunityId = slackQualifiedOpportunity._id;

  await patchOpportunityLifecycle(ctx, opportunityId, {
    status: "scheduled",
    calendlyEventUri,
    assignedCloserId: nextAssignedCloserId,
    hostCalendlyUserUri: hostUserUri,
    hostCalendlyEmail,
    hostCalendlyName,
    eventTypeConfigId: meetingEventTypeConfigId,
    updatedAt: now,
  });

  await preserveQualificationAuditMatchForScheduledMeeting(ctx, {
    tenantId,
    leadId: lead._id,
    opportunityId,
    now,
  });
}
```

**Step 3: Add explicit no-lookup comments in cold-booking paths.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
// Lead Gen Ops intentionally does not search leadGenProspects here.
// Cold Calendly bookings are not Lead Gen matches; only Slack qualification
// can create the accepted audit bridge.
```

**Key implementation notes:**
- Do not move or reorder the existing identity resolution and Slack join behavior beyond the minimal helper call.
- The helper reads `leadGenAuditMatches` by `(tenantId, leadId)` only; it never scans prospects.
- If no existing accepted match is found, do nothing.
- If an accepted match already points at a different opportunity, do not overwrite it silently.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Preserve existing audit match in Slack-qualified scheduling branch only |

---

### 4D — Read-Only Audit Display Queries

**Type:** Backend  
**Parallelizable:** Yes — depends on 4A; optional for MVP if UI display is deferred.

**What:** Add admin/read-only queries for prospect audit details and CRM audit panels.

**Why:** If audit matches are visible, they must be clearly traceability-only and backed by bounded tenant-scoped queries.

**Where:**
- `convex/leadGen/auditQueries.ts` (new)

**How:**

**Step 1: Add prospect detail query for admins.**

```typescript
// Path: convex/leadGen/auditQueries.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getProspectAuditDetail = query({
  args: {
    prospectId: v.id("leadGenProspects"),
  },
  handler: async (ctx, { prospectId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const prospect = await ctx.db.get(prospectId);
    if (!prospect || prospect.tenantId !== tenantId) {
      throw new Error("Prospect not found");
    }

    const matches = await ctx.db
      .query("leadGenAuditMatches")
      .withIndex("by_tenantId_and_prospectId", (q) =>
        q.eq("tenantId", tenantId).eq("prospectId", prospect._id),
      )
      .take(25);

    return { prospect, matches };
  },
});
```

**Step 2: Add CRM lead audit panel query.**

```typescript
// Path: convex/leadGen/auditQueries.ts
export const getAuditMatchForLead = query({
  args: {
    leadId: v.id("leads"),
  },
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const matches = await ctx.db
      .query("leadGenAuditMatches")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .take(5);

    return matches.find((match) => match.matchStatus === "accepted") ?? null;
  },
});
```

**Key implementation notes:**
- If closer access to audit panels is not desired, restrict `getAuditMatchForLead` to admins. The design permits read-only traceability, not worker compensation views.
- Do not expose audit count as conversion rate. Label it as "Prior Lead Gen activity."
- Avoid N+1 detail joins in UI; add a single DTO query if display requires prospect, worker, and CRM labels together.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/auditQueries.ts` | Create | Optional read-only audit detail queries |

---

### 4E — Optional Traceability UI Surfaces

**Type:** Frontend  
**Parallelizable:** Yes — depends on 4D; can be deferred without blocking backend audit matching.

**What:** Add read-only audit panels/tables for admins and, if approved, CRM lead/opportunity detail surfaces.

**Why:** Audit matching is valuable only if admins can inspect it, but the UI must not imply Lead Gen Ops is a conversion source.

**Where:**
- `app/workspace/lead-gen/prospects/page.tsx` (new)
- `app/workspace/lead-gen/prospects/[prospectId]/page.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-prospects-table.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-prospect-detail-client.tsx` (new)
- `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` (optional modify)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` (optional modify)

**How:**

**Step 1: Add admin prospects route if included in MVP.**

```tsx
// Path: app/workspace/lead-gen/prospects/page.tsx
import { requirePermission } from "@/lib/auth";
import { LeadGenProspectsTable } from "../_components/lead-gen-prospects-table";

export const unstable_instant = false;

export default async function LeadGenProspectsPage() {
  await requirePermission("lead-gen:view-all");
  return <LeadGenProspectsTable />;
}
```

**Step 2: Use audit-specific labels.**

```tsx
// Path: app/workspace/lead-gen/_components/audit-match-badge.tsx
import { Badge } from "@/components/ui/badge";

export function AuditMatchBadge({ matched }: { matched: boolean }) {
  return matched ? (
    <Badge variant="secondary">Prior Lead Gen activity</Badge>
  ) : (
    <Badge variant="outline">No audit match</Badge>
  );
}
```

**Step 3: Keep CRM display read-only.**

```tsx
// Path: app/workspace/leads/[leadId]/_components/lead-gen-audit-panel.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function LeadGenAuditPanel({ leadId }: { leadId: Id<"leads"> }) {
  const match = useQuery(api.leadGen.auditQueries.getAuditMatchForLead, {
    leadId,
  });

  if (match === undefined || match === null) return null;

  return (
    <section className="flex flex-col gap-2 rounded-md border p-4">
      <h2 className="text-sm font-medium">Prior Lead Gen activity</h2>
      <p className="text-sm text-muted-foreground">
        Matched by social handle. This is audit traceability only.
      </p>
    </section>
  );
}
```

**Key implementation notes:**
- This UI is optional for MVP. If delivery risk is high, ship backend audit matching and add UI in a later phase.
- Do not use terms like "converted from Lead Gen" or "Lead Gen conversion rate."
- Tables should link to prospect details only for admins; workers should not browse all prospects.
- Keep card radius and density aligned with existing workspace pages.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/lead-gen/prospects/page.tsx` | Create | Optional admin prospects route |
| `app/workspace/lead-gen/prospects/[prospectId]/page.tsx` | Create | Optional prospect detail route |
| `app/workspace/lead-gen/_components/lead-gen-prospects-table.tsx` | Create | Optional prospects table |
| `app/workspace/lead-gen/_components/lead-gen-prospect-detail-client.tsx` | Create | Optional detail client |
| `app/workspace/leads/[leadId]/_components/lead-gen-audit-panel.tsx` | Create | Optional CRM traceability panel |
| `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` | Modify | Optional panel placement |

---

### 4F — Slack and Calendly Regression Gate

**Type:** QA / Integration  
**Parallelizable:** No — runs after 4B and 4C, and after seed capture data exists.

**What:** Re-run existing Slack qualification and Calendly invitee-created scenarios with and without prior Lead Gen prospects.

**Why:** The main risk is not audit matching failing; it is accidentally changing existing Slack/Calendly CRM behavior.

**Where:**
- `convex/slack/createQualifiedLead.ts` (verify)
- `convex/pipeline/inviteeCreated.ts` (verify)
- `convex/leadGen/auditMatching.ts` (verify)
- `plans/lead-gen-ops/phases/phase0-qa-matrix.md` (read)

**How:**

**Step 1: Run static blast-radius checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
rg "leadGen" convex/slack convex/pipeline
rg "leadGenProspects" convex/pipeline/inviteeCreated.ts
```

Expected:

- `leadGen` appears only in `createQualifiedLead.ts` and `inviteeCreated.ts` integration hooks.
- `leadGenProspects` should not appear in `inviteeCreated.ts`.

**Step 2: Slack QA matrix.**

```markdown
<!-- Path: QA notes -->

- New Slack qualification + prior Lead Gen prospect -> accepted audit match.
- Duplicate pending Slack qualification + prior Lead Gen prospect -> accepted match reused or created for existing opportunity.
- Already booked Slack qualification + prior Lead Gen prospect -> no accepted audit match by default.
- Slack qualification without prior prospect -> existing Slack behavior; no audit match.
- Slack failed/unlinked flow -> no audit match.
```

**Step 3: Calendly QA matrix.**

```markdown
<!-- Path: QA notes -->

- Calendly joins Slack-qualified opportunity with existing audit match -> match remains and `opportunityId` is filled if missing.
- Calendly joins Slack-qualified opportunity without audit match -> no match created.
- Calendly cold booking with matching Lead Gen handle -> no Lead Gen lookup, no audit match.
- Calendly cold booking without matching handle -> existing behavior unchanged.
```

**Key implementation notes:**
- Include logs tagged `[LeadGen:Audit]` only at key decisions; avoid noisy logs on every cold booking path.
- If regression QA fails, revert the integration hook before changing core Slack/Calendly flow.
- Do not mark Phase 4 complete until both matching-positive and no-op-negative cases pass.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| No production code | Verify | Slack/Calendly regression gate |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leadGen/auditMatching.ts` | Create | 4A |
| `convex/slack/createQualifiedLead.ts` | Modify | 4B |
| `convex/pipeline/inviteeCreated.ts` | Modify | 4C |
| `convex/leadGen/auditQueries.ts` | Create | 4D |
| `app/workspace/lead-gen/prospects/page.tsx` | Create | 4E |
| `app/workspace/lead-gen/prospects/[prospectId]/page.tsx` | Create | 4E |
| `app/workspace/lead-gen/_components/lead-gen-prospects-table.tsx` | Create | 4E |
| `app/workspace/lead-gen/_components/lead-gen-prospect-detail-client.tsx` | Create | 4E |
| `app/workspace/leads/[leadId]/_components/lead-gen-audit-panel.tsx` | Create | 4E |
| `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` | Modify | 4E |
