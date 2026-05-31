# Phase 4 — Opportunity Sheet, Meeting Links, and Legacy Redirects

**Goal:** Add the URL-addressable left-side opportunity sheet, finalize role-aware meeting links from the entity page, and turn legacy Leads, Customers, and Opportunities routes into safe redirect shims. After this phase, old links continue to work while the new lead-centric route becomes functionally complete.

**Prerequisite:** Phase 1E redirect/search facade exists. Phase 1F detail payload includes permission metadata. Phase 2 browse route and Phase 3 detail route are implemented and verified in development. Old navigation has not been flipped yet.

**Runs in PARALLEL with:** Phase 5 rollout documentation can begin after 4D redirect resolver contracts are known. Phase 5 navigation changes must wait until 4E redirect shims are verified.

**Skills to invoke:**
- `shadcn` — compose `Sheet`, `SheetContent side="left"`, `SheetHeader`, `SheetTitle`, `SheetDescription`, and compact sheet sections.
- `frontend-design` — keep the sheet dense and operational while the entity page remains visible behind it.
- `next-best-practices` — implement redirect shims with server components, async params/searchParams, `fetchQuery`, `redirect()`, and `notFound()`.
- `vercel-react-best-practices` — lazy-load opportunity detail only when `opportunityId` exists in URL state.
- `web-design-guidelines` — verify focus, close behavior, keyboard escape, new-tab links, and mobile sheet width.

**Acceptance Criteria:**
1. `/workspace/leads-customers/[leadId]?opportunityId=<id>` opens a left-side sheet without leaving the entity detail page.
2. Closing the sheet removes only `opportunityId` from the URL and preserves the current lead detail route.
3. The sheet reuses or extracts existing opportunity meetings, payments, activity, and side-deal action behavior without bypassing existing Convex guards.
4. Unauthorized opportunity detail requests return a controlled unavailable state in the sheet and do not expose payments, comments, or actions.
5. Meeting links from entity detail and sheet use `/workspace/pipeline/meetings/[meetingId]` for tenant owners/admins and `/workspace/closer/meetings/[meetingId]` for closers.
6. Legacy list routes redirect as follows: `/workspace/leads` -> `/workspace/leads-customers`, `/workspace/customers` -> `/workspace/leads-customers?lifecycle=customer`, and `/workspace/opportunities` -> `/workspace/leads-customers`.
7. Legacy detail routes redirect as follows: lead detail -> new lead detail, customer detail -> lead detail, opportunity detail -> lead detail with sheet open, opportunity new -> new side-deal route.
8. `/workspace/leads/[leadId]/merge` remains available until a future merge route is built.
9. Redirect resolvers derive tenant/user/role from auth and return `null` for missing or cross-tenant IDs.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (sheet URL state) ───────────────┬── 4B (sheet body + reused sections) ───┐
                                   │                                        │
3E meeting rows ───────────────────┴── 4C (meeting link helper) ────────────┤
                                                                            ├── 4F (sheet/redirect QA)
1E query facade ────────────────────── 4D (redirect resolvers) ── 4E (route shims) ┘
```

**Optimal execution:**
1. Run 4A and 4D in parallel. They touch different directories and establish independent contracts.
2. Build 4B after 4A, reusing existing opportunity detail query and components.
3. Build 4C after meeting section shape is known from Phase 3.
4. Build 4E after 4D resolver API names are stable.
5. Finish with 4F integrated QA because sheet links, redirects, and route permissions cross multiple surfaces.

**Estimated time:** 3-5 days

---

## Subphases

### 4A — Sheet URL State and Shell

**Type:** Frontend
**Parallelizable:** Yes — depends on Phase 3 route structure but not on redirect resolvers.

**What:** Add a URL-state helper and mount `OpportunityDetailSheet` from the entity detail page.

**Why:** Opportunity detail should be deep-linkable and shareable without navigating away from the person/entity context.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/use-selected-opportunity-id.ts` (new)
- `app/workspace/leads-customers/[leadId]/_components/opportunity-detail-sheet.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx` (modify)

**How:**

**Step 1: Add URL state helper.**

```typescript
// Path: app/workspace/leads-customers/[leadId]/_components/use-selected-opportunity-id.ts
"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";

export function useSelectedOpportunityId() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawOpportunityId = searchParams.get("opportunityId");

  const clearSelectedOpportunity = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("opportunityId");
    const suffix = next.toString();
    router.replace(`${pathname}${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }, [pathname, router, searchParams]);

  return {
    opportunityId: rawOpportunityId as Id<"opportunities"> | null,
    clearSelectedOpportunity,
  };
}
```

**Step 2: Add the sheet shell.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/opportunity-detail-sheet.tsx
"use client";

import { useQuery } from "convex/react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/convex/_generated/api";
import { OpportunitySheetBody } from "./opportunity-sheet-body";
import { useSelectedOpportunityId } from "./use-selected-opportunity-id";

export function OpportunityDetailSheet() {
  const { opportunityId, clearSelectedOpportunity } = useSelectedOpportunityId();
  const detail = useQuery(
    api.opportunities.detailQuery.getOpportunityDetail,
    opportunityId ? { opportunityId } : "skip",
  );

  return (
    <Sheet
      open={Boolean(opportunityId)}
      onOpenChange={(open) => {
        if (!open) clearSelectedOpportunity();
      }}
    >
      <SheetContent side="left" className="w-full overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-4 py-3 text-left">
          <SheetTitle>Opportunity Detail</SheetTitle>
          <SheetDescription>
            Opportunity context for the selected lead or customer.
          </SheetDescription>
        </SheetHeader>
        <OpportunitySheetBody detail={detail} />
      </SheetContent>
    </Sheet>
  );
}
```

**Step 3: Mount the sheet in the detail frame.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx
import { OpportunityDetailSheet } from "./opportunity-detail-sheet";

export function EntityDetailFrame() {
  return (
    <>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        {/* Existing detail sections */}
      </div>
      <OpportunityDetailSheet />
    </>
  );
}
```

**Key implementation notes:**
- Closing the sheet must not remove other future query params.
- Avoid loading `getOpportunityDetail` when no `opportunityId` exists.
- Invalid manually typed `opportunityId` values should render the unavailable state from the query/error boundary rather than crash the whole detail page.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/use-selected-opportunity-id.ts` | Create | URL state helper |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-detail-sheet.tsx` | Create | Sheet shell |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx` | Modify | Mount sheet |

---

### 4B — Opportunity Sheet Body and Extracted Sections

**Type:** Frontend
**Parallelizable:** Yes — depends on 4A sheet shell but not on legacy route shims.

**What:** Build the sheet body using existing `api.opportunities.detailQuery.getOpportunityDetail` payload and reuse/extract existing opportunity sections where they fit the dense sheet layout.

**Why:** The old full-page opportunity detail has the richest opportunity context. The sheet should preserve behavior without duplicating authorization or action logic.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` (read/reuse or modify for compact props)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` (read/reuse or modify for compact props)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` (read/reuse or modify for compact props)

**How:**

**Step 1: Add loading/unavailable/body switch.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx
"use client";

import { CalendarXIcon } from "lucide-react";
import { EntityAttributionCard } from "@/app/workspace/_components/entity-attribution-card";
import { OpportunityActivityTimeline } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline";
import { OpportunityMeetingsList } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list";
import { OpportunityPaymentsList } from "@/app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { api } from "@/convex/_generated/api";
import { OpportunitySheetSummary } from "./opportunity-sheet-summary";

type OpportunityDetail = Awaited<ReturnType<typeof api.opportunities.detailQuery.getOpportunityDetail>>;

export function OpportunitySheetBody({
  detail,
}: {
  detail: OpportunityDetail | undefined;
}) {
  if (detail === undefined) {
    return (
      <div className="space-y-4 p-4" role="status" aria-label="Loading opportunity detail">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="p-4">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarXIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Opportunity unavailable</EmptyTitle>
            <EmptyDescription>
              It may have been reassigned, removed, or outside your access.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const meetingBasePath =
    detail.permissions.viewerRole === "closer"
      ? "/workspace/closer/meetings"
      : "/workspace/pipeline/meetings";

  return (
    <div className="flex flex-col gap-4 p-4">
      <OpportunitySheetSummary detail={detail} />
      <EntityAttributionCard attribution={detail.attribution} />
      <OpportunityMeetingsList meetings={detail.meetings} meetingBasePath={meetingBasePath} />
      <OpportunityPaymentsList payments={detail.payments} />
      <OpportunityActivityTimeline events={detail.events} />
    </div>
  );
}
```

**Step 2: Add compact summary and actions.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import type { api } from "@/convex/_generated/api";

type OpportunityDetail = NonNullable<
  Awaited<ReturnType<typeof api.opportunities.detailQuery.getOpportunityDetail>>
>;

export function OpportunitySheetSummary({ detail }: { detail: OpportunityDetail }) {
  return (
    <section className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{detail.opportunity.source}</Badge>
        <Badge>{detail.opportunity.status}</Badge>
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Closer</dt>
          <dd className="font-medium">{detail.closer?.fullName ?? detail.closer?.email ?? "Unassigned"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Booked program</dt>
          <dd className="font-medium">{detail.opportunity.firstBookingProgramName ?? "Not mapped"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sold program</dt>
          <dd className="font-medium">{detail.opportunity.soldProgramName ?? "Not sold"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Payment received</dt>
          <dd className="font-medium">{detail.opportunity.paymentReceivedAt ? "Yes" : "No"}</dd>
        </div>
      </dl>
    </section>
  );
}
```

**Step 3: Extract shared opportunity actions only if needed.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-actions.tsx
"use client";

import { DeleteOpportunityDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog";
import { MarkSideDealLostDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog";
import { SideDealPaymentDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog";
import { VoidPaymentDialog } from "@/app/workspace/opportunities/[opportunityId]/_components/void-payment-dialog";
import type { Id } from "@/convex/_generated/dataModel";

export function OpportunitySheetActions({
  opportunityId,
  permissions,
}: {
  opportunityId: Id<"opportunities">;
  permissions: {
    canRecordPayment: boolean;
    canMarkLost: boolean;
    canVoidPayment: boolean;
    canDeleteOpportunity: boolean;
    voidablePaymentId?: Id<"paymentRecords">;
  };
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {permissions.canRecordPayment ? <SideDealPaymentDialog opportunityId={opportunityId} /> : null}
      {permissions.canMarkLost ? <MarkSideDealLostDialog opportunityId={opportunityId} /> : null}
      {permissions.canVoidPayment && permissions.voidablePaymentId ? (
        <VoidPaymentDialog paymentId={permissions.voidablePaymentId} />
      ) : null}
      {permissions.canDeleteOpportunity ? <DeleteOpportunityDialog opportunityId={opportunityId} /> : null}
    </div>
  );
}
```

**Key implementation notes:**
- If existing opportunity components are too card-heavy for the sheet, add compact props or wrappers instead of duplicating business logic.
- Existing mutations remain guarded by their current Convex permissions.
- The sheet should be full-width on mobile and `sm:max-w-xl` or similar on larger screens.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx` | Create | Query body switch and section composition |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx` | Create | Compact summary |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-actions.tsx` | Create | Optional extracted action composition |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Modify | Only if compact/reuse props are needed |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` | Modify | Only if compact/reuse props are needed |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` | Modify | Only if compact/reuse props are needed |

---

### 4C — Meeting Link Helper and Entity Row Integration

**Type:** Frontend
**Parallelizable:** Yes — independent from redirect route shims after Phase 3 meeting rows exist.

**What:** Centralize meeting detail href selection and update entity/sheet meeting rows to use it.

**Why:** Admins and closers have different canonical meeting routes. Duplicating path logic risks sending a closer to an admin-only page or vice versa.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/meeting-link-utils.ts` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx` (modify)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` (modify only if needed)

**How:**

**Step 1: Add the link helper.**

```typescript
// Path: app/workspace/leads-customers/[leadId]/_components/meeting-link-utils.ts
import type { Id } from "@/convex/_generated/dataModel";
import type { CrmRole } from "@/convex/lib/roleMapping";

export function meetingDetailHref(input: {
  meetingId: Id<"meetings">;
  viewerRole: CrmRole;
}) {
  const basePath =
    input.viewerRole === "closer"
      ? "/workspace/closer/meetings"
      : "/workspace/pipeline/meetings";
  return `${basePath}/${input.meetingId}`;
}
```

**Step 2: Use the helper in entity meeting rows.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx
import { useRole } from "@/components/auth/role-context";
import { meetingDetailHref } from "./meeting-link-utils";

// Inside EntityMeetingRow:
const { role } = useRole();
const href = meetingDetailHref({ meetingId: meeting._id, viewerRole: role });

// Existing Button asChild:
<Link href={href} target="_blank" rel="noreferrer">
  Open Meeting
  <ExternalLinkIcon aria-hidden="true" />
</Link>
```

**Step 3: Keep sheet meeting links consistent.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx
const meetingBasePath =
  detail.permissions.viewerRole === "closer"
    ? "/workspace/closer/meetings"
    : "/workspace/pipeline/meetings";

<OpportunityMeetingsList meetings={detail.meetings} meetingBasePath={meetingBasePath} />;
```

**Key implementation notes:**
- Use `target="_blank"` and `rel="noreferrer"` from every meeting action.
- Do not construct meeting URLs from client-provided role. Role comes from `RoleProvider` or backend detail payload.
- If the existing `OpportunityMeetingsList` already accepts `meetingBasePath`, keep that API and only centralize path selection in new code.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/meeting-link-utils.ts` | Create | Role-aware meeting route helper |
| `app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx` | Modify | Use helper |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Modify | Only if needed for consistency |

---

### 4D — Legacy Redirect Resolver Queries

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 1E conventions, but not on sheet UI implementation.

**What:** Add Convex queries that resolve old customer/opportunity/lead IDs into the canonical lead-centric target while enforcing tenant and role checks.

**Why:** Server route shims need authenticated target lookup without accepting tenant or user identity from URL params.

**Where:**
- `convex/leadCustomers/redirects.ts` (new)

**How:**

**Step 1: Add lead redirect resolver.**

```typescript
// Path: convex/leadCustomers/redirects.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const resolveLeadRedirect = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) return null;
    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      const target = await ctx.db.get(lead.mergedIntoLeadId);
      if (target?.tenantId === tenantId) return { leadId: target._id };
    }
    return { leadId: lead._id };
  },
});
```

**Step 2: Add customer redirect resolver.**

```typescript
// Path: convex/leadCustomers/redirects.ts
export const resolveCustomerRedirect = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, { customerId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const customer = await ctx.db.get(customerId);
    if (!customer || customer.tenantId !== tenantId) return null;
    return { leadId: customer.leadId, customerId: customer._id };
  },
});
```

**Step 3: Add opportunity redirect resolver with closer assignment check.**

```typescript
// Path: convex/leadCustomers/redirects.ts
export const resolveOpportunityRedirect = query({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) return null;
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    if (!isAdmin && opportunity.assignedCloserId !== userId) return null;
    return {
      leadId: opportunity.leadId,
      opportunityId: opportunity._id,
    };
  },
});
```

**Key implementation notes:**
- Return `null` for every inaccessible target; route shims call `notFound()`.
- Do not use route-level permission alone as a substitute for tenant checks.
- If closer broad opportunity list behavior differs from detail behavior, keep this resolver aligned with existing `getOpportunityDetail`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadCustomers/redirects.ts` | Create | Legacy target resolvers |

---

### 4E — Legacy Route Redirect Shims

**Type:** Next.js / Full-Stack
**Parallelizable:** No — depends on 4D resolver API names and Phase 2/3 route targets.

**What:** Replace legacy list/detail route pages with server redirects while keeping merge route files intact.

**Why:** Reports, reminders, operations tables, browser history, and shared links must not break when the canonical workspace changes.

**Where:**
- `app/workspace/leads/page.tsx` (modify)
- `app/workspace/leads/[leadId]/page.tsx` (modify)
- `app/workspace/customers/page.tsx` (modify)
- `app/workspace/customers/[customerId]/page.tsx` (modify)
- `app/workspace/opportunities/page.tsx` (modify)
- `app/workspace/opportunities/[opportunityId]/page.tsx` (modify)
- `app/workspace/opportunities/new/page.tsx` (modify)
- `app/workspace/leads/[leadId]/merge/page.tsx` (keep, do not modify unless links need updated copy)

**How:**

**Step 1: Redirect legacy list routes.**

```tsx
// Path: app/workspace/leads/page.tsx
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requirePermission("lead:view-all");
  const { status } = await searchParams;
  const params = new URLSearchParams();
  if (status === "converted") params.set("lifecycle", "customer");
  redirect(`/workspace/leads-customers${params.toString() ? `?${params}` : ""}`);
}
```

```tsx
// Path: app/workspace/customers/page.tsx
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCustomersPage() {
  await requirePermission("customer:view-own");
  redirect("/workspace/leads-customers?lifecycle=customer");
}
```

```tsx
// Path: app/workspace/opportunities/page.tsx
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyOpportunitiesPage() {
  await requirePermission("pipeline:view-own");
  redirect("/workspace/leads-customers");
}
```

**Step 2: Redirect legacy detail routes.**

```tsx
// Path: app/workspace/customers/[customerId]/page.tsx
import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { session } = await requirePermission("customer:view-own");
  const { customerId } = await params;
  const target = await fetchQuery(
    api.leadCustomers.redirects.resolveCustomerRedirect,
    { customerId: customerId as Id<"customers"> },
    { token: session.accessToken },
  );

  if (!target) notFound();
  redirect(`/workspace/leads-customers/${target.leadId}`);
}
```

```tsx
// Path: app/workspace/opportunities/[opportunityId]/page.tsx
import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyOpportunityDetailPage({
  params,
}: {
  params: Promise<{ opportunityId: string }>;
}) {
  const { session } = await requirePermission("pipeline:view-own");
  const { opportunityId } = await params;
  const target = await fetchQuery(
    api.leadCustomers.redirects.resolveOpportunityRedirect,
    { opportunityId: opportunityId as Id<"opportunities"> },
    { token: session.accessToken },
  );

  if (!target) notFound();
  redirect(
    `/workspace/leads-customers/${target.leadId}?opportunityId=${target.opportunityId}`,
  );
}
```

**Step 3: Redirect legacy lead and create routes.**

```tsx
// Path: app/workspace/leads/[leadId]/page.tsx
import { fetchQuery } from "convex/nextjs";
import { notFound, redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyLeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { session } = await requirePermission("lead:view-all");
  const { leadId } = await params;
  const target = await fetchQuery(
    api.leadCustomers.redirects.resolveLeadRedirect,
    { leadId: leadId as Id<"leads"> },
    { token: session.accessToken },
  );

  if (!target) notFound();
  redirect(`/workspace/leads-customers/${target.leadId}`);
}
```

```tsx
// Path: app/workspace/opportunities/new/page.tsx
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyCreateOpportunityPage() {
  await requirePermission("pipeline:view-own");
  redirect("/workspace/leads-customers/new-opportunity");
}
```

**Key implementation notes:**
- Keep `app/workspace/leads/[leadId]/merge/page.tsx` intact.
- Remove old client imports from redirected pages to avoid bundling unused legacy UI.
- Keep old loading files unless they are harmless; route-level redirect pages generally will not show them.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/page.tsx` | Modify | Redirect list |
| `app/workspace/leads/[leadId]/page.tsx` | Modify | Resolve/redirect detail |
| `app/workspace/customers/page.tsx` | Modify | Redirect list |
| `app/workspace/customers/[customerId]/page.tsx` | Modify | Resolve/redirect detail |
| `app/workspace/opportunities/page.tsx` | Modify | Redirect list |
| `app/workspace/opportunities/[opportunityId]/page.tsx` | Modify | Resolve/redirect detail with sheet query |
| `app/workspace/opportunities/new/page.tsx` | Modify | Redirect create route |
| `app/workspace/leads/[leadId]/merge/page.tsx` | Keep | Existing merge route remains |

---

### 4F — Sheet, Link, and Redirect QA

**Type:** Manual QA / Full-Stack
**Parallelizable:** No — depends on 4A through 4E.

**What:** Verify all redirect paths, sheet states, unauthorized cases, meeting links, and mobile sheet behavior.

**Why:** This phase changes route behavior. Failures here break existing links or expose related-record detail outside established guards.

**Where:**
- `plans/leads-customers-unified-view/phase4-qa.md` (new)

**How:**

**Step 1: Create redirect QA matrix.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase4-qa.md -->

# Phase 4 QA — Sheet and Legacy Redirects

| Legacy URL | Expected target | Admin | Closer assigned | Closer unassigned |
|---|---|---|---|---|
| `/workspace/leads` | `/workspace/leads-customers` | TBD | TBD | TBD |
| `/workspace/leads/[leadId]` | `/workspace/leads-customers/[leadId]` | TBD | TBD | TBD |
| `/workspace/leads/[sourceMergedLeadId]` | target lead route | TBD | TBD | TBD |
| `/workspace/customers` | `/workspace/leads-customers?lifecycle=customer` | TBD | TBD | TBD |
| `/workspace/customers/[customerId]` | lead route | TBD | TBD | TBD |
| `/workspace/opportunities` | `/workspace/leads-customers` | TBD | TBD | TBD |
| `/workspace/opportunities/[opportunityId]` | lead route with `opportunityId` | TBD | TBD | 404 or unavailable |
| `/workspace/opportunities/new` | `/workspace/leads-customers/new-opportunity` | TBD | TBD | TBD |
```

**Step 2: Create sheet QA matrix.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase4-qa.md -->

## Sheet Checks

- [ ] Opening `?opportunityId=` shows sheet on desktop.
- [ ] Closing sheet removes only `opportunityId`.
- [ ] Browser back closes/restores URL state correctly.
- [ ] Mobile sheet is full-width and scrolls internally.
- [ ] Escape key closes the sheet.
- [ ] Unauthorized opportunity renders unavailable state.
- [ ] Side-deal actions appear only when existing detail permissions allow them.
- [ ] Meeting links open in a new tab with role-correct route.
```

**Step 3: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
```

**Key implementation notes:**
- Check redirect status in the browser and via route navigation from old reports/operations links if available.
- Do not flip sidebar links in this phase unless Phase 5 starts immediately after successful QA.
- If redirect loops appear, inspect list route redirects first.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/phase4-qa.md` | Create | Redirect and sheet QA evidence |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/use-selected-opportunity-id.ts` | Create | 4A |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-detail-sheet.tsx` | Create | 4A |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx` | Modify | 4A |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-body.tsx` | Create | 4B |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-summary.tsx` | Create | 4B |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-sheet-actions.tsx` | Create | 4B |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Modify | 4B / 4C |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` | Modify | 4B |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` | Modify | 4B |
| `app/workspace/leads-customers/[leadId]/_components/meeting-link-utils.ts` | Create | 4C |
| `app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx` | Modify | 4C |
| `convex/leadCustomers/redirects.ts` | Create | 4D |
| `app/workspace/leads/page.tsx` | Modify | 4E |
| `app/workspace/leads/[leadId]/page.tsx` | Modify | 4E |
| `app/workspace/customers/page.tsx` | Modify | 4E |
| `app/workspace/customers/[customerId]/page.tsx` | Modify | 4E |
| `app/workspace/opportunities/page.tsx` | Modify | 4E |
| `app/workspace/opportunities/[opportunityId]/page.tsx` | Modify | 4E |
| `app/workspace/opportunities/new/page.tsx` | Modify | 4E |
| `plans/leads-customers-unified-view/phase4-qa.md` | Create | 4F |
