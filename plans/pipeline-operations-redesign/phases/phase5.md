# Phase 5 — Unified Entity Detail and Attribution Surfaces

**Goal:** Surface the complete qualification -> booking -> phone-sales -> payment attribution chain on opportunity, customer, lead, and meeting detail pages while preserving `/workspace/opportunities/[id]` as the canonical opportunity detail route.

**Prerequisite:** Phase 2 attribution/booked/sold cache fields are dual-written and backfilled. Phase 3 qualification ledger/projections exist. Phase 4 Operations rows link to existing opportunity and admin meeting detail routes.

**Runs in PARALLEL with:** Phase 6 reporting copy and report links can start after the field naming in 5A is stable.

**Skills to invoke:**
- `frontend-design` — Detail pages should show attribution as compact operational context, not marketing cards.
- `shadcn` — Use Card, Badge, Alert, Separator, Table, and Button primitives.
- `vercel-react-best-practices` — Keep detail query payloads bounded and avoid duplicate client fetches for related labels.
- `convex-performance-audit` — Detail queries can enrich data, but must bound meetings, payments, events, and qualification events.

**Acceptance Criteria:**
1. Opportunity detail shows Slack qualifier, booked program, sold program, DM team/closer, raw UTM fallback, phone closer, and qualification/booking/outcome timestamps.
2. Customer detail shows attribution from the winning opportunity and winning meeting, including booked program and sold program as separate fields.
3. Lead detail lists opportunities with source badges and highlights Slack-qualified opportunities and returning-lead qualification attempts.
4. Existing meeting attribution cards show booked program, sold program, DM team/closer labels, and internal/unmapped attribution states.
5. Customer "Winning Opportunity" links to `/workspace/opportunities/[id]`, not the legacy `/workspace/pipeline?opp=...` route.
6. Rebooking or returning-lead flows do not overwrite first external booking attribution, first booked program, or Slack qualification metadata.
7. `resultKind: "unlinked"` qualification rows keep the Phase 3 repair/diagnostic state visible from Operations and never route users to a missing opportunity detail.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (detail query enrichment) ──────────┬── 5B (shared attribution card)
                                      │
5B complete ─────────┬────────────────┼── 5C (opportunity detail UI)
                     ├────────────────┼── 5D (customer detail UI)
                     └────────────────┘── 5E (lead detail UI)

5C + 5D complete ─────────────────────── 5F (meeting cards + preservation verification)
```

**Optimal execution:**
1. Start with 5A because UI components need one stable attribution payload shape.
2. Build a shared display component in 5B.
3. Apply it to opportunity/customer/lead detail pages.
4. Finish by enhancing meeting detail attribution and verifying first-touch preservation.

**Estimated time:** 3-4 days

---

## Subphases

### 5A — Detail Query Attribution Payloads

**Type:** Backend
**Parallelizable:** No — the UI depends on these return shapes.

**What:** Enrich opportunity, customer, and lead detail queries with attribution labels, qualification events, booked/sold program fields, and phone closer labels.

**Why:** The client should not run several independent Convex subscriptions just to render one detail page.

**Where:**
- `convex/opportunities/detailQuery.ts` (modify)
- `convex/customers/queries.ts` (modify)
- `convex/leads/queries.ts` (modify)
- `app/workspace/operations/_components/qualification-repair-sheet.tsx` (verify / modify)
- `convex/lib/attribution/detailPayload.ts` (new)

**How:**

**Step 1: Create a reusable attribution payload helper.**

```typescript
// Path: convex/lib/attribution/detailPayload.ts
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

export type EntityAttributionPayload = {
  slackQualification: {
    slackUserId: string;
    slackUserLabel: string;
    submittedAt: number;
    resultKind: Doc<"slackQualificationEvents">["resultKind"];
  } | null;
  bookedProgram: { id: Id<"tenantPrograms">; name: string } | null;
  soldProgram: { id: Id<"tenantPrograms">; name: string } | null;
  dmAttribution: {
    status: Doc<"opportunities">["attributionResolution"] | Doc<"meetings">["attributionResolution"] | "none";
    teamName: string | null;
    dmCloserName: string | null;
    rawSource: string | null;
    rawMedium: string | null;
  };
  phoneCloser: { id: Id<"users">; name: string } | null;
  timeline: {
    qualifiedAt: number | null;
    firstBookedAt: number | null;
    firstMeetingAt: number | null;
    paymentReceivedAt: number | null;
  };
};

export async function buildOpportunityAttributionPayload(
  ctx: QueryCtx,
  opportunity: Doc<"opportunities">,
): Promise<EntityAttributionPayload> {
  const [qualificationEvent, team, dmCloser, phoneCloser] = await Promise.all([
    ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_opportunityId", (q) =>
        q.eq("tenantId", opportunity.tenantId).eq("opportunityId", opportunity._id),
      )
      .order("desc")
      .first(),
    opportunity.attributionTeamId ? ctx.db.get(opportunity.attributionTeamId) : Promise.resolve(null),
    opportunity.dmCloserId ? ctx.db.get(opportunity.dmCloserId) : Promise.resolve(null),
    opportunity.assignedCloserId ? ctx.db.get(opportunity.assignedCloserId) : Promise.resolve(null),
  ]);

  return {
    slackQualification: qualificationEvent
      ? {
          slackUserId: qualificationEvent.slackUserId,
          slackUserLabel: qualificationEvent.slackUserId,
          submittedAt: qualificationEvent.submittedAt,
          resultKind: qualificationEvent.resultKind,
        }
      : null,
    bookedProgram: opportunity.firstBookingProgramId && opportunity.firstBookingProgramName
      ? { id: opportunity.firstBookingProgramId, name: opportunity.firstBookingProgramName }
      : null,
    soldProgram: opportunity.soldProgramId && opportunity.soldProgramName
      ? { id: opportunity.soldProgramId, name: opportunity.soldProgramName }
      : null,
    dmAttribution: {
      status: opportunity.attributionResolution ?? "none",
      teamName: team?.displayName ?? null,
      dmCloserName: dmCloser?.displayName ?? null,
      rawSource: opportunity.utmParams?.utm_source ?? null,
      rawMedium: opportunity.utmParams?.utm_medium ?? null,
    },
    phoneCloser: phoneCloser
      ? { id: phoneCloser._id, name: phoneCloser.fullName ?? phoneCloser.email }
      : null,
    timeline: {
      qualifiedAt: opportunity.qualifiedAt ?? opportunity.qualifiedBy?.submittedAt ?? null,
      firstBookedAt: opportunity.firstBookedAt ?? null,
      firstMeetingAt: opportunity.firstMeetingAt ?? null,
      paymentReceivedAt: opportunity.paymentReceivedAt ?? null,
    },
  };
}
```

**Step 2: Add the payload to opportunity detail.**

```typescript
// Path: convex/opportunities/detailQuery.ts
import { buildOpportunityAttributionPayload } from "../lib/attribution/detailPayload";

const attribution = await buildOpportunityAttributionPayload(ctx, opportunity);

return {
  opportunity: {
    _id: opportunity._id,
    status: opportunity.status,
    source,
    notes: opportunity.notes,
    assignedCloserId: opportunity.assignedCloserId,
    firstBookingProgramId: opportunity.firstBookingProgramId,
    firstBookingProgramName: opportunity.firstBookingProgramName,
    soldProgramId: opportunity.soldProgramId,
    soldProgramName: opportunity.soldProgramName,
    createdAt: opportunity.createdAt,
    updatedAt: opportunity.updatedAt,
    latestActivityAt: opportunity.latestActivityAt,
    paymentReceivedAt: opportunity.paymentReceivedAt,
    lostAt: opportunity.lostAt,
    lostReason: opportunity.lostReason,
  },
  attribution,
  // existing fields remain
};
```

**Step 3: Add winning-opportunity attribution to customer detail.**

```typescript
// Path: convex/customers/queries.ts
import { buildOpportunityAttributionPayload } from "../lib/attribution/detailPayload";

const attribution = winningOpportunity
  ? await buildOpportunityAttributionPayload(ctx, winningOpportunity)
  : null;

return {
  customer: {
    ...customer,
    programName: resolveLegacyCompatibleCustomerProgramName(customer),
  },
  attribution,
  // existing fields remain
};
```

**Key implementation notes:**
- Label enrichment should stay bounded: one latest qualification event, one team, one DM closer, one phone closer.
- If Slack display names are needed, load `slackUsers` through an indexed lookup by tenant/team/user and fall back to Slack ID.
- Keep raw UTM values in the payload for display only; do not make them filter keys in detail pages.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/attribution/detailPayload.ts` | Create | Shared payload builder |
| `convex/opportunities/detailQuery.ts` | Modify | Include attribution payload |
| `convex/customers/queries.ts` | Modify | Include winning attribution |
| `convex/leads/queries.ts` | Modify | Include qualification events and badges |

---

### 5B — Shared Attribution Summary Component

**Type:** Frontend
**Parallelizable:** Yes — starts after 5A payload shape is drafted.

**What:** Create a reusable `EntityAttributionCard` for opportunity and customer detail surfaces.

**Why:** The same business concepts must render consistently across detail pages and avoid duplicating label logic.

**Where:**
- `app/workspace/_components/entity-attribution-card.tsx` (new)

**How:**

**Step 1: Build a compact card around the backend payload.**

```tsx
// Path: app/workspace/_components/entity-attribution-card.tsx
"use client";

import { CalendarCheckIcon, MessageSquareTextIcon, PhoneCallIcon, TagsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

type EntityAttribution = {
  slackQualification: {
    slackUserId: string;
    slackUserLabel: string;
    submittedAt: number;
    resultKind: string;
  } | null;
  bookedProgram: { name: string } | null;
  soldProgram: { name: string } | null;
  dmAttribution: {
    status: "mapped" | "unmapped" | "internal" | "none";
    teamName: string | null;
    dmCloserName: string | null;
    rawSource: string | null;
    rawMedium: string | null;
  };
  phoneCloser: { name: string } | null;
  timeline: {
    qualifiedAt: number | null;
    firstBookedAt: number | null;
    firstMeetingAt: number | null;
    paymentReceivedAt: number | null;
  };
};

export function EntityAttributionCard({ attribution }: { attribution: EntityAttribution | null }) {
  if (!attribution) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TagsIcon aria-hidden="true" />
          Attribution
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AttributionField
            icon={<MessageSquareTextIcon aria-hidden="true" />}
            label="Slack qualifier"
            value={attribution.slackQualification?.slackUserLabel ?? "Not Slack-qualified"}
          />
          <AttributionField
            icon={<CalendarCheckIcon aria-hidden="true" />}
            label="Booked program"
            value={attribution.bookedProgram?.name ?? "Unmapped"}
          />
          <AttributionField
            icon={<PhoneCallIcon aria-hidden="true" />}
            label="Phone closer"
            value={attribution.phoneCloser?.name ?? "Unassigned"}
          />
          <AttributionField
            label="DM team"
            value={attribution.dmAttribution.teamName ?? attribution.dmAttribution.rawSource ?? "None"}
          />
          <AttributionField
            label="DM closer"
            value={attribution.dmAttribution.dmCloserName ?? attribution.dmAttribution.rawMedium ?? "None"}
          />
          <AttributionField
            label="Sold program"
            value={attribution.soldProgram?.name ?? "No payment yet"}
          />
        </div>
        <Separator />
        <div className="flex flex-wrap gap-2">
          <Badge variant={attribution.dmAttribution.status === "mapped" ? "secondary" : "outline"}>
            {attribution.dmAttribution.status}
          </Badge>
          {attribution.slackQualification ? (
            <Badge variant="outline">{attribution.slackQualification.resultKind}</Badge>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function AttributionField({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon ? <span className="[&>svg]:size-3">{icon}</span> : null}
        {label}
      </p>
      <p className="truncate text-sm font-medium">{value}</p>
    </div>
  );
}
```

**Key implementation notes:**
- Keep the component display-only. Mutations belong in Settings or action dialogs.
- Use semantic variants and existing cards.
- If raw UTM strings are long, truncate visually but keep the full value in a tooltip only if needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/entity-attribution-card.tsx` | Create | Shared attribution UI |

---

### 5C — Opportunity Detail Surface

**Type:** Frontend
**Parallelizable:** Yes — depends on 5A and 5B.

**What:** Add attribution context to the canonical opportunity detail page.

**Why:** Operations rows deep-link to opportunities, and this page should explain why a lead exists, who qualified it, how it booked, and what it bought.

**Where:**
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` (modify)

**How:**

**Step 1: Render the shared card below the summary.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx
import { EntityAttributionCard } from "@/app/workspace/_components/entity-attribution-card";

const {
  opportunity,
  lead,
  closer,
  meetings,
  payments,
  events,
  pendingStaleNudge,
  permissions,
  attribution,
} = data;

<SectionErrorBoundary sectionName="Attribution">
  <EntityAttributionCard attribution={attribution} />
</SectionErrorBoundary>
```

**Step 2: Add contextual alert for Slack qualification.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx
{attribution?.slackQualification ? (
  <Alert>
    <MessageSquareTextIcon aria-hidden="true" />
    <AlertDescription>
      Qualified via Slack by {attribution.slackQualification.slackUserLabel} on{" "}
      {formatDateTime(attribution.slackQualification.submittedAt)}.
    </AlertDescription>
  </Alert>
) : null}
```

**Key implementation notes:**
- Do not duplicate meeting list or payment list content; the card summarizes attribution only.
- Keep `/workspace/opportunities/[id]` canonical for opportunity detail.
- Preserve side-deal controls and stale nudge behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Modify | Add attribution card and Slack context |

---

### 5D — Customer Detail Attribution

**Type:** Full-Stack
**Parallelizable:** Yes — depends on 5A and 5B.

**What:** Show winning opportunity attribution and fix the winning opportunity link.

**Why:** Mauro specifically asked for meeting attribution on customer/opportunity pages. Customers need booked/sold program separation after conversion.

**Where:**
- `convex/customers/queries.ts` (modify)
- `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` (modify)

**How:**

**Step 1: Use the attribution payload returned by `getCustomerDetail`.**

```tsx
// Path: app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx
import { EntityAttributionCard } from "@/app/workspace/_components/entity-attribution-card";

const {
  customer,
  lead,
  winningOpportunity,
  winningMeeting,
  convertedByName,
  closerName,
  totalPaid,
  currency,
  payments,
  attribution,
} = detail;

<EntityAttributionCard attribution={attribution} />
```

**Step 2: Fix the legacy opportunity link.**

```tsx
// Path: app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx
{winningOpportunity && (
  <Link
    href={`/workspace/opportunities/${customer.winningOpportunityId}`}
    className="block rounded-lg border p-3 transition-colors hover:bg-accent"
  >
    <p className="text-xs text-muted-foreground">Winning Opportunity</p>
    <p className="font-medium capitalize">
      {winningOpportunity.status.replace(/_/g, " ")}
    </p>
  </Link>
)}
```

**Key implementation notes:**
- The customer `programId/programName` remains sold program.
- Booked program comes from the winning opportunity/meeting, not the customer row.
- Existing closer-facing meeting links may still use `/workspace/closer/meetings/[id]`; admin-only links can point to `/workspace/pipeline/meetings/[id]` if viewer role is added later.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/customers/queries.ts` | Modify | Return attribution payload |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Modify | Render card and fix link |

---

### 5E — Lead Detail Qualification Context

**Type:** Full-Stack
**Parallelizable:** Yes — depends on 5A.

**What:** Add qualification events and source/program badges to lead detail opportunity views.

**Why:** A returning lead may have multiple qualification attempts or multiple opportunities; lead detail should make that history visible without replacing Operations.

**Where:**
- `convex/leads/queries.ts` (modify)
- `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx` (modify)
- `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` (modify)

**How:**

**Step 1: Add qualification events to `getLeadDetail`.**

```typescript
// Path: convex/leads/queries.ts
const qualificationEvents = await ctx.db
  .query("slackQualificationEvents")
  .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", leadId),
  )
  .order("desc")
  .take(20);

return {
  lead,
  identifiers,
  opportunities,
  qualificationEvents: qualificationEvents.map((event) => ({
    _id: event._id,
    resultKind: event.resultKind,
    slackUserId: event.slackUserId,
    submittedAt: event.submittedAt,
    opportunityId: event.opportunityId,
  })),
  // existing fields remain
};
```

**Step 2: Add source and program badges to opportunity rows.**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx
<div className="flex flex-wrap items-center gap-2">
  <OpportunitySourceBadge source={opportunity.source ?? "calendly"} />
  {opportunity.firstBookingProgramName ? (
    <Badge variant="outline">Booked: {opportunity.firstBookingProgramName}</Badge>
  ) : null}
  {opportunity.soldProgramName ? (
    <Badge variant="secondary">Sold: {opportunity.soldProgramName}</Badge>
  ) : null}
</div>
```

**Key implementation notes:**
- Keep `take(20)` on qualification events; this is context, not the full Operations queue.
- Use `OpportunitySourceBadge` to stay consistent with the Opportunities page.
- Returning-lead badges should not imply a duplicate merge recommendation unless identity-resolution data says so.
- Verify the Phase 3 repair sheet still has enough event snapshot fields after detail query changes; do not move unlinked rows into opportunity/customer detail because they have no canonical entity yet.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/queries.ts` | Modify | Return qualification events |
| `app/workspace/operations/_components/qualification-repair-sheet.tsx` | Verify / Modify | Preserve unlinked diagnostics |
| `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx` | Modify | Source/program badges |
| `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` | Modify | Recent qualification context |

---

### 5F — Meeting Attribution and Preservation Verification

**Type:** Full-Stack / Manual
**Parallelizable:** No — verify after detail surfaces are wired.

**What:** Enhance existing meeting `AttributionCard` and verify pipeline flows preserve first-touch fields.

**Why:** Meeting detail is still the operational drill-down from Phone Sales, and rebooking flows are the highest-risk place to overwrite attribution incorrectly.

**Where:**
- `app/workspace/closer/meetings/_components/attribution-card.tsx` (modify)
- `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` (modify if it passes attribution props)
- `convex/closer/meetingDetail.ts` (modify if labels are missing)
- `convex/admin/meetingActions.ts` (verify)
- `convex/pipeline/inviteeCreated.ts` (verify)

**How:**

**Step 1: Add booked/sold program and resolved labels to meeting detail payloads.**

```typescript
// Path: convex/closer/meetingDetail.ts
return {
  meeting: {
    ...meeting,
    bookingProgramName: meeting.bookingProgramName,
    soldProgramName: meeting.soldProgramName,
    attributionResolution: meeting.attributionResolution ?? "none",
  },
  attributionTeam: meeting.attributionTeamId ? await ctx.db.get(meeting.attributionTeamId) : null,
  dmCloser: meeting.dmCloserId ? await ctx.db.get(meeting.dmCloserId) : null,
  // existing fields remain
};
```

**Step 2: Display mapped/internal/unmapped attribution.**

```tsx
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx
<div className="grid gap-3 sm:grid-cols-2">
  <UtmField label="Booked Program" value={meeting.bookingProgramName ?? "Unmapped"} />
  <UtmField label="Sold Program" value={meeting.soldProgramName ?? "No payment yet"} />
  <UtmField label="DM Team" value={attributionTeam?.displayName ?? utm?.utm_source ?? "None"} />
  <UtmField label="DM Closer" value={dmCloser?.displayName ?? utm?.utm_medium ?? "None"} />
</div>
```

**Step 3: Verify first-touch preservation.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
pnpm tsc --noEmit
```

Manual cases:

| Case | Expected |
|---|---|
| Slack-qualified lead books external Calendly link | Opportunity first-booking and attribution fields are set once |
| Same opportunity books `utm_source=ptdom` follow-up | Meeting stores internal UTM; opportunity first-touch fields do not change |
| Payment logged for a different program than booked | Sold program differs from booked program and both render |
| Duplicate Slack qualification after already booked | New qualification event appears; opportunity attribution remains intact |

**Key implementation notes:**
- The meeting card may receive raw docs today; if so, either enrich the query or pass labels separately. Do not make the client query registry tables separately.
- Admin meeting detail and closer meeting detail should render the same attribution semantics even if actions differ.
- Preservation checks are more important than visual polish in this subphase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | Modify | Program and resolved attribution display |
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | Modify | Pass/render attribution as needed |
| `convex/closer/meetingDetail.ts` | Modify | Include labels |
| `convex/pipeline/inviteeCreated.ts` | Verify | First-touch preservation |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/attribution/detailPayload.ts` | Create | 5A |
| `convex/opportunities/detailQuery.ts` | Modify | 5A |
| `convex/customers/queries.ts` | Modify | 5A, 5D |
| `convex/leads/queries.ts` | Modify | 5A, 5E |
| `app/workspace/operations/_components/qualification-repair-sheet.tsx` | Verify / Modify | 5E |
| `app/workspace/_components/entity-attribution-card.tsx` | Create | 5B |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Modify | 5C |
| `app/workspace/customers/[customerId]/_components/customer-detail-page-client.tsx` | Modify | 5D |
| `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx` | Modify | 5E |
| `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` | Modify | 5E |
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | Modify | 5F |
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | Modify | 5F |
| `convex/closer/meetingDetail.ts` | Modify | 5F |
| `convex/pipeline/inviteeCreated.ts` | Verify | 5F |
