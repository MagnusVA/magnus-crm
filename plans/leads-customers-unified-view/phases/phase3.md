# Phase 3 — Entity Detail Page

**Goal:** Add `/workspace/leads-customers/[leadId]` as the lead-centric detail page for active leads and converted customers, showing identity, customer state, opportunities, meetings, comments, payments, activity, fields, identifiers, and attribution directly on the page. After this phase, users no longer need separate lead/customer detail layouts to understand a person.

**Prerequisite:** Phase 1F detail query contract exists. Phase 2 route namespace exists. Phase 4 opportunity sheet is not required yet, but opportunity rows should already generate URL-addressable `opportunityId` links for that later sheet.

**Runs in PARALLEL with:** Phase 2 browse workspace after Phase 1 contracts are stable. Phase 4 sheet implementation can start once 3B defines the detail provider and 3D defines opportunity row link behavior.

**Skills to invoke:**
- `frontend-design` — build a compact operational detail page with dense sections and no tab-hidden data.
- `shadcn` — compose `Badge`, `Button`, `Table`, `Separator`, `Skeleton`, `Tooltip`, and section primitives.
- `next-best-practices` — use thin App Router page files, async params, Suspense/loading, and Convex preloading correctly.
- `vercel-react-best-practices` — avoid data waterfalls; read the preloaded detail once and keep section props minimal.
- `vercel-composition-patterns` — provider-backed detail sections avoid boolean prop proliferation.
- `web-design-guidelines` — audit readable hierarchy, focus order, keyboard links, overflow, and mobile behavior.

**Acceptance Criteria:**
1. `/workspace/leads-customers/[leadId]` is gated by `requirePermission("lead:view-all")` and loads the initial detail payload with the current WorkOS/Convex token.
2. A valid active lead renders identity, opportunities, meetings, comments, activity, fields, identifiers, and attribution sections without tabs.
3. A converted customer renders the same layout plus a prominent customer lifecycle strip with converted date, status, total paid, winning opportunity, and sold program.
4. A missing or cross-tenant lead renders a controlled not-found state without leaking existence.
5. A merged source lead follows the Phase 1 detail contract by redirecting to the target lead or rendering a controlled redirect state until Phase 4 legacy redirects are active.
6. Opportunity rows show status, source, closer, booked/sold program, payment summary, permission metadata, and a Details link that sets `?opportunityId=<id>`.
7. Meeting rows show status, date, closer, opportunity context, notes/artifacts when available, inline active comments, and a new-tab meeting link only when the viewer is allowed to open it.
8. All sections have compact empty/capped states and do not produce layout gaps when data is absent.
9. Mobile detail sections wrap cleanly and do not overlap action buttons, badges, timestamps, or long identifiers.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (route + preload + skeleton) ──────────┬── 3B (detail provider + frame)
                                          │
                                          ├── 3C (header + identity/customer strip)
                                          │
3B complete ──────────────────────────────┼── 3D (opportunities + payments)
                                          │
                                          ├── 3E (meetings + comments)
                                          │
                                          └── 3F (activity + fields + attribution)

3C + 3D + 3E + 3F complete ───────────────── 3G (detail QA + polish)
```

**Optimal execution:**
1. Build 3A first so the route can load a preloaded detail payload.
2. Build 3B immediately after 3A; every visible section consumes the shared provider.
3. Run 3C, 3D, 3E, and 3F in parallel because they own separate section files and consume the same context.
4. Finish with 3G integration QA and visual polish.

**Estimated time:** 4-6 days

---

## Subphases

### 3A — Detail Route, Preload, Loading, and Skeleton

**Type:** Frontend / Next.js
**Parallelizable:** No — this route boundary and preloaded data contract unblock all section work.

**What:** Add the dynamic detail route, server gate, Convex preload, loading file, and skeleton.

**Why:** Detail sections should render from one initial payload to avoid a client-side data waterfall across opportunities, meetings, comments, and payments.

**Where:**
- `app/workspace/leads-customers/[leadId]/page.tsx` (new)
- `app/workspace/leads-customers/[leadId]/loading.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-skeleton.tsx` (new)

**How:**

**Step 1: Add the RSC route.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/page.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { EntityDetailPageClient } from "./_components/entity-detail-page-client";

export const unstable_instant = false;

export default async function LeadCustomerDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { session } = await requirePermission("lead:view-all");
  const { leadId } = await params;
  const typedLeadId = leadId as Id<"leads">;
  const preloadedDetail = await preloadQuery(
    api.leadCustomers.detail.getEntityDetail,
    { leadId: typedLeadId },
    { token: session.accessToken },
  );

  return <EntityDetailPageClient preloadedDetail={preloadedDetail} />;
}
```

**Step 2: Add route loading.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/loading.tsx
import { EntityDetailSkeleton } from "./_components/entity-detail-skeleton";

export default function Loading() {
  return <EntityDetailSkeleton />;
}
```

**Step 3: Add the skeleton.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function EntityDetailSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8"
      role="status"
      aria-label="Loading lead or customer detail"
    >
      <Skeleton className="h-8 w-44" />
      <div className="rounded-md border p-4">
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
        <Skeleton className="mt-4 h-10 w-full" />
      </div>
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="rounded-md border p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-16 w-full" />
        </div>
      ))}
    </div>
  );
}
```

**Key implementation notes:**
- Do not call `fetchQuery` in the RSC just to duplicate the preloaded read unless the implementation decides server-side redirect is required for merged leads.
- Keep route file thin and preserve `unstable_instant = false`.
- The page should not depend on Phase 4 sheet code to render base detail.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/page.tsx` | Create | RSC gate and preload |
| `app/workspace/leads-customers/[leadId]/loading.tsx` | Create | Segment loading state |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-skeleton.tsx` | Create | Detail skeleton |

---

### 3B — Detail Client, Provider, Frame, and State Boundaries

**Type:** Frontend
**Parallelizable:** No — all visual sections consume the provider and frame from this subphase.

**What:** Add the client boundary that reads the preloaded query, handles null/redirect variants, and provides detail context to section components.

**Why:** A provider-backed composition keeps section components focused and prevents wide prop chains as the detail surface grows.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-page-client.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-context.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-empty-states.tsx` (new)

**How:**

**Step 1: Add the preloaded client boundary.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-page-client.tsx
"use client";

import { useEffect } from "react";
import { type Preloaded, usePreloadedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { EntityDetailProvider } from "./entity-detail-context";
import { EntityDetailFrame } from "./entity-detail-layout";
import { EntityDetailNotFound } from "./entity-detail-empty-states";

export function EntityDetailPageClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<typeof api.leadCustomers.detail.getEntityDetail>;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);

  useEffect(() => {
    if (detail?.kind === "redirect") {
      router.replace(`/workspace/leads-customers/${detail.leadId}`);
    }
  }, [detail, router]);

  if (detail === null) return <EntityDetailNotFound />;
  if (detail.kind === "redirect") return null;

  return (
    <EntityDetailProvider detail={detail}>
      <EntityDetailFrame />
    </EntityDetailProvider>
  );
}
```

**Step 2: Add the detail context.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-context.tsx
"use client";

import { createContext, use, type ReactNode } from "react";
import type { api } from "@/convex/_generated/api";

type EntityDetailPayload = NonNullable<
  Awaited<ReturnType<typeof api.leadCustomers.detail.getEntityDetail>>
>;

type DetailOnlyPayload = Extract<EntityDetailPayload, { kind: "detail" }>;

const EntityDetailContext = createContext<DetailOnlyPayload | null>(null);

export function EntityDetailProvider({
  detail,
  children,
}: {
  detail: DetailOnlyPayload;
  children: ReactNode;
}) {
  return <EntityDetailContext value={detail}>{children}</EntityDetailContext>;
}

export function useEntityDetail() {
  const detail = use(EntityDetailContext);
  if (!detail) throw new Error("useEntityDetail must be used inside EntityDetailProvider");
  return detail;
}
```

**Step 3: Add the frame with section slots.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx
"use client";

import { EntityActivitySection } from "./entity-activity-section";
import { EntityHeaderSection } from "./entity-header-section";
import { EntityIdentityChain } from "./entity-identity-chain";
import { EntityMeetingsSection } from "./entity-meetings-section";
import { EntityOpportunitiesSection } from "./entity-opportunities-section";
import { EntityPaymentsSection } from "./entity-payments-section";
import { EntityFieldsIdentifiersSection } from "./entity-fields-identifiers-section";

export function EntityDetailFrame() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
      <EntityHeaderSection />
      <EntityIdentityChain />
      <EntityOpportunitiesSection />
      <EntityMeetingsSection />
      <EntityPaymentsSection />
      <EntityActivitySection />
      <EntityFieldsIdentifiersSection />
    </div>
  );
}
```

**Step 4: Add controlled empty states.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-empty-states.tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function EntityDetailNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">Lead not found</h1>
      <p className="text-sm text-muted-foreground">
        This record is unavailable or you do not have access to it.
      </p>
      <Button asChild variant="outline" className="mx-auto">
        <Link href="/workspace/leads-customers">Back to Leads & Customers</Link>
      </Button>
    </div>
  );
}
```

**Key implementation notes:**
- Type extraction from generated `api` may need adjustment; if TypeScript cannot infer public query returns from `api`, define and export DTO types from `convex/leadCustomers/types.ts`.
- Redirect handling can move server-side later if Phase 4 redirect resolvers provide a better RSC target.
- Keep state local to section components only when it affects presentation, not source data.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-page-client.tsx` | Create | Preloaded query reader |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-context.tsx` | Create | Detail provider |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx` | Create | Section frame |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-empty-states.tsx` | Create | Not-found/empty UI |

---

### 3C — Header, Lifecycle Strip, and Identity Chain

**Type:** Frontend
**Parallelizable:** Yes — depends on 3B context but does not touch opportunities/meetings section files.

**What:** Build the top identity header, lifecycle badges, customer strip, and compact identity chain.

**Why:** Users need to understand whether the person is an active lead, converted customer, or merged target immediately without switching layouts.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-identity-chain.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-detail-formatters.ts` (new)

**How:**

**Step 1: Add formatters.**

```typescript
// Path: app/workspace/leads-customers/[leadId]/_components/entity-detail-formatters.ts
export function formatDate(value: number | undefined) {
  if (value === undefined) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function formatMoneyMinor(value: number | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format((value ?? 0) / 100);
}
```

**Step 2: Build the header.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx
"use client";

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useEntityDetail } from "./entity-detail-context";
import { formatDate, formatMoneyMinor } from "./entity-detail-formatters";

export function EntityHeaderSection() {
  const { lead, customer } = useEntityDetail();
  const displayName = customer?.fullName ?? lead.fullName ?? lead.email ?? "Unknown lead";
  const isCustomer = customer !== null;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="w-fit px-0">
          <Link href="/workspace/leads-customers">
            <ArrowLeftIcon aria-hidden="true" />
            Leads & Customers
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
              <Badge variant={isCustomer ? "default" : "secondary"}>
                {isCustomer ? "Customer" : "Lead"}
              </Badge>
              {customer ? <Badge variant="outline">{customer.status}</Badge> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {lead.email ? <span>{lead.email}</span> : null}
              {lead.phone ? <span>{lead.phone}</span> : null}
              {(lead.socialHandles ?? []).slice(0, 3).map((handle) => (
                <span key={`${handle.type}:${handle.handle}`}>{handle.type} {handle.handle}</span>
              ))}
            </div>
          </div>
        </div>
        {customer ? (
          <>
            <Separator />
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-muted-foreground">Converted</div>
                <div className="font-medium">{formatDate(customer.convertedAt)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Total paid</div>
                <div className="font-medium tabular-nums">
                  {formatMoneyMinor(customer.totalPaidMinor, customer.paymentCurrency)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Program</div>
                <div className="font-medium">{customer.programName}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Status</div>
                <div className="font-medium capitalize">{customer.status}</div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
```

**Step 3: Add the identity chain.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-identity-chain.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { useEntityDetail } from "./entity-detail-context";

export function EntityIdentityChain() {
  const { lead, customer, opportunities } = useEntityDetail();
  const winning = opportunities.find(({ opportunity }) =>
    customer ? opportunity._id === customer.winningOpportunityId : false,
  );

  return (
    <section className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">Lead</Badge>
        <span className="font-medium">{lead.fullName ?? lead.email ?? lead._id}</span>
        {customer ? (
          <>
            <span className="text-muted-foreground">to</span>
            <Badge>Customer</Badge>
            <span className="font-medium">{customer.status}</span>
          </>
        ) : null}
        {winning ? (
          <>
            <span className="text-muted-foreground">to</span>
            <Badge variant="outline">Winning opportunity</Badge>
            <span className="font-medium">{winning.opportunity.status}</span>
          </>
        ) : null}
      </div>
    </section>
  );
}
```

**Key implementation notes:**
- Keep lifecycle state visually obvious but not loud for every field.
- Long emails, handles, and names must truncate or wrap without forcing horizontal scroll.
- If customer/lead data contains mismatched identity snapshots, show lead canonical identity first and customer state as lifecycle context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx` | Create | Identity and customer strip |
| `app/workspace/leads-customers/[leadId]/_components/entity-identity-chain.tsx` | Create | Lead/customer/winning opportunity chain |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-formatters.ts` | Create | Date/money formatters |

---

### 3D — Opportunities and Payments Sections

**Type:** Frontend
**Parallelizable:** Yes — depends on 3B context but is independent from meetings/activity sections.

**What:** Render every opportunity summary and customer/payment rows in dense, scannable sections.

**Why:** Opportunities are the main reason to open the entity detail. Users should see all opportunity context without leaving the person page.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/entity-opportunities-section.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-payments-section.tsx` (new)

**How:**

**Step 1: Add the opportunities section.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-opportunities-section.tsx
"use client";

import { useEntityDetail } from "./entity-detail-context";
import { EntityOpportunityRow } from "./entity-opportunity-row";

export function EntityOpportunitiesSection() {
  const { opportunities, caps } = useEntityDetail();

  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold">Opportunities</h2>
        {caps?.opportunities ? (
          <span className="text-xs text-muted-foreground">Showing latest 50</span>
        ) : null}
      </div>
      {opportunities.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No opportunities yet.</div>
      ) : (
        <div className="divide-y">
          {opportunities.map((item) => (
            <EntityOpportunityRow key={item.opportunity._id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
```

**Step 2: Add opportunity rows with sheet-ready links.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftOpenIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Doc } from "@/convex/_generated/dataModel";

type OpportunityItem = {
  opportunity: Doc<"opportunities">;
  permissions: { canOpenDetail: boolean };
};

export function EntityOpportunityRow({ item }: { item: OpportunityItem }) {
  const pathname = usePathname();
  const params = new URLSearchParams({ opportunityId: item.opportunity._id });

  return (
    <div className="grid gap-3 p-3 text-sm md:grid-cols-[1.5fr_1fr_1fr_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{item.opportunity.status}</Badge>
          <Badge variant="outline">{item.opportunity.source ?? "calendly"}</Badge>
        </div>
        <div className="mt-1 truncate font-medium">
          {item.opportunity.soldProgramName ??
            item.opportunity.firstBookingProgramName ??
            "Program not set"}
        </div>
      </div>
      <div className="text-muted-foreground">
        Booked: {item.opportunity.firstBookingProgramName ?? "Not mapped"}
      </div>
      <div className="text-muted-foreground">
        Sold: {item.opportunity.soldProgramName ?? "Not sold"}
      </div>
      {item.permissions.canOpenDetail ? (
        <Button asChild variant="outline" size="sm">
          <Link href={`${pathname}?${params.toString()}`}>
            <PanelLeftOpenIcon aria-hidden="true" />
            Details
          </Link>
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">Summary only</span>
      )}
    </div>
  );
}
```

**Step 3: Add payments section.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-payments-section.tsx
"use client";

import { useEntityDetail } from "./entity-detail-context";
import { formatDate, formatMoneyMinor } from "./entity-detail-formatters";

export function EntityPaymentsSection() {
  const { payments, caps } = useEntityDetail();

  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold">Payments</h2>
        {caps.payments ? <span className="text-xs text-muted-foreground">Showing latest 50</span> : null}
      </div>
      {payments.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No payments recorded.</div>
      ) : (
        <div className="divide-y">
          {payments.map((payment) => (
            <div key={payment._id} className="grid gap-2 p-3 text-sm sm:grid-cols-[1fr_auto_auto]">
              <div className="min-w-0">
                <div className="truncate font-medium">{payment.programName}</div>
                <div className="text-xs text-muted-foreground">{payment.paymentType}</div>
              </div>
              <div className="tabular-nums">{formatMoneyMinor(payment.amountMinor, payment.currency)}</div>
              <div className="text-muted-foreground">{formatDate(payment.recordedAt)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

**Key implementation notes:**
- Permission-limited opportunity rows should never show a clickable sheet action.
- Keep row layout stable whether Details is present or summary-only.
- Payment actions remain in existing guarded flows; Phase 3 only displays allowed rows from the detail payload.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/entity-opportunities-section.tsx` | Create | Opportunity section |
| `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx` | Create | Opportunity summary/action row |
| `app/workspace/leads-customers/[leadId]/_components/entity-payments-section.tsx` | Create | Payment rows |

---

### 3E — Meetings, Inline Comments, and New-Tab Links

**Type:** Frontend
**Parallelizable:** Yes — depends on 3B context but does not touch opportunity/payment files.

**What:** Render meeting rows with inline notes/comments and role-aware new-tab links.

**Why:** Meeting context and comments are high-value operational details. They must be visible on-page but bounded.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/entity-meetings-section.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-comments-list.tsx` (new)

**How:**

**Step 1: Add the meetings section.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-meetings-section.tsx
"use client";

import { useEntityDetail } from "./entity-detail-context";
import { EntityMeetingRow } from "./entity-meeting-row";

export function EntityMeetingsSection() {
  const { meetings, comments, caps } = useEntityDetail();
  const commentsByMeetingId = new Map<string, typeof comments>();
  for (const comment of comments) {
    const existing = commentsByMeetingId.get(comment.meetingId) ?? [];
    existing.push(comment);
    commentsByMeetingId.set(comment.meetingId, existing);
  }

  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold">Meetings</h2>
        {caps.meetings ? <span className="text-xs text-muted-foreground">Showing latest 50</span> : null}
      </div>
      {meetings.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No meetings found.</div>
      ) : (
        <div className="divide-y">
          {meetings.map((meeting) => (
            <EntityMeetingRow
              key={meeting._id}
              meeting={meeting}
              comments={commentsByMeetingId.get(meeting._id) ?? []}
            />
          ))}
        </div>
      )}
    </section>
  );
}
```

**Step 2: Add role-aware meeting rows.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx
"use client";

import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { useRole } from "@/components/auth/role-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Doc } from "@/convex/_generated/dataModel";
import { formatDate } from "./entity-detail-formatters";
import { EntityCommentsList } from "./entity-comments-list";

export function EntityMeetingRow({
  meeting,
  comments,
}: {
  meeting: Doc<"meetings"> & { canOpenDetail?: boolean };
  comments: Array<Doc<"meetingComments">>;
}) {
  const { isAdmin } = useRole();
  const basePath = isAdmin ? "/workspace/pipeline/meetings" : "/workspace/closer/meetings";
  const canOpen = meeting.canOpenDetail !== false;

  return (
    <div className="p-3 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{meeting.status}</Badge>
            {meeting.callClassification ? (
              <Badge variant="outline">{meeting.callClassification}</Badge>
            ) : null}
          </div>
          <div className="mt-1 font-medium">{formatDate(meeting.scheduledAt)}</div>
          {meeting.notes ? (
            <p className="mt-2 line-clamp-3 text-muted-foreground">{meeting.notes}</p>
          ) : null}
        </div>
        {canOpen ? (
          <Button asChild variant="ghost" size="sm" className="shrink-0">
            <Link href={`${basePath}/${meeting._id}`} target="_blank" rel="noreferrer">
              Open Meeting
              <ExternalLinkIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </div>
      <EntityCommentsList comments={comments} />
    </div>
  );
}
```

**Step 3: Add comments list.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-comments-list.tsx
"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import { formatDate } from "./entity-detail-formatters";

export function EntityCommentsList({
  comments,
}: {
  comments: Array<Doc<"meetingComments">>;
}) {
  if (comments.length === 0) return null;

  return (
    <div className="mt-3 space-y-2 border-l pl-3">
      <div className="text-xs font-medium text-muted-foreground">Comments</div>
      {comments.map((comment) => (
        <div key={comment._id} className="text-sm">
          <div className="text-muted-foreground">{formatDate(comment.createdAt)}</div>
          <p className="mt-1 whitespace-pre-wrap">{comment.content}</p>
        </div>
      ))}
    </div>
  );
}
```

**Key implementation notes:**
- The backend should omit deleted comments; the UI should still tolerate missing/empty comment arrays.
- Do not show meeting detail links for rows the backend marks inaccessible.
- If author names are needed, add bounded author enrichment in Phase 1F instead of client-side follow-up queries per comment.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/entity-meetings-section.tsx` | Create | Meeting section |
| `app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx` | Create | Role-aware meeting row |
| `app/workspace/leads-customers/[leadId]/_components/entity-comments-list.tsx` | Create | Inline comments |

---

### 3F — Activity, Fields, Identifiers, and Attribution

**Type:** Frontend
**Parallelizable:** Yes — depends on 3B context but is independent from header/opportunity/meeting files.

**What:** Add the activity timeline, custom fields, identifiers, and compact attribution grid.

**Why:** The unified detail page must make the same facts currently spread across lead, customer, and opportunity pages visible in one scroll.

**Where:**
- `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-fields-identifiers-section.tsx` (new)
- `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx` (new)

**How:**

**Step 1: Add activity section.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx
"use client";

import { useEntityDetail } from "./entity-detail-context";
import { formatDate } from "./entity-detail-formatters";

export function EntityActivitySection() {
  const { activity, caps } = useEntityDetail();

  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold">Activity</h2>
        {caps.activity ? <span className="text-xs text-muted-foreground">Showing latest 75</span> : null}
      </div>
      {activity.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No activity yet.</div>
      ) : (
        <div className="divide-y">
          {activity.map((event) => (
            <div key={`${event.kind}:${event.at}`} className="grid gap-1 p-3 text-sm sm:grid-cols-[9rem_1fr]">
              <div className="text-muted-foreground">{formatDate(event.at)}</div>
              <div className="font-medium">{event.kind.replaceAll("_", " ")}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

**Step 2: Add fields and identifiers.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-fields-identifiers-section.tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { useEntityDetail } from "./entity-detail-context";

export function EntityFieldsIdentifiersSection() {
  const { lead, identifiers } = useEntityDetail();
  const customFields = Object.entries(lead.customFields ?? {});

  return (
    <section className="rounded-md border">
      <div className="border-b p-3">
        <h2 className="text-sm font-semibold">Fields & Identifiers</h2>
      </div>
      <div className="grid gap-4 p-3 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Identifiers</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {identifiers.length === 0 ? (
              <span className="text-sm text-muted-foreground">No identifiers recorded.</span>
            ) : (
              identifiers.map((identifier) => (
                <Badge key={identifier._id} variant="outline">
                  {identifier.type}: {identifier.rawValue}
                </Badge>
              ))
            )}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Custom fields</h3>
          {customFields.length === 0 ? (
            <div className="mt-2 text-sm text-muted-foreground">No custom fields recorded.</div>
          ) : (
            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
              {customFields.map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="truncate text-muted-foreground">{key}</dt>
                  <dd className="break-words font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}
```

**Step 3: Add compact attribution grid where payload supports it.**

```tsx
// Path: app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx
"use client";

export function EntityAttributionGrid({
  attribution,
}: {
  attribution: Record<string, string | number | null | undefined> | null;
}) {
  if (!attribution) return null;

  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {Object.entries(attribution).map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="truncate text-muted-foreground">{key}</dt>
          <dd className="truncate font-medium">{value ?? "Not set"}</dd>
        </div>
      ))}
    </dl>
  );
}
```

**Key implementation notes:**
- If attribution data is per-opportunity, render the compact grid inside opportunity rows or the Phase 4 sheet rather than inventing page-level attribution.
- Identifier values are PII; rendering is allowed inside authenticated UI, but analytics and logs must never include them.
- Custom fields can contain long text; use wrapping and avoid fixed-height clipping except for previews.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx` | Create | Timeline |
| `app/workspace/leads-customers/[leadId]/_components/entity-fields-identifiers-section.tsx` | Create | Custom fields and identifiers |
| `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx` | Create | Compact attribution display |

---

### 3G — Detail QA, Section Polish, and Cross-Role Checks

**Type:** Frontend / Manual QA
**Parallelizable:** No — depends on all detail sections.

**What:** Validate the detail page against sample records, roles, mobile/dark layouts, and section caps.

**Why:** The detail page consolidates high-value operational data; regressions are more likely at section boundaries and role-specific actions.

**Where:**
- `plans/leads-customers-unified-view/phase3-qa.md` (new)
- `app/workspace/leads-customers/[leadId]/**` (modify if defects are found)

**How:**

**Step 1: Create the QA matrix.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase3-qa.md -->

# Phase 3 QA — Entity Detail

| Scenario | Admin | Closer assigned | Closer unassigned | Notes |
|---|---|---|---|---|
| Active lead with one opportunity | TBD | TBD | TBD |  |
| Converted customer with payment | TBD | TBD | TBD |  |
| Entity with 2+ opportunities | TBD | TBD | TBD |  |
| Meeting with comments | TBD | TBD | TBD | Deleted comments hidden. |
| Opportunity permission denied | N/A | N/A | TBD | Summary-only row. |
| Missing lead | TBD | TBD | TBD | Controlled not-found. |
| Merged source lead | TBD | TBD | TBD | Redirect or controlled redirect state. |
| Mobile viewport | TBD | TBD | TBD | No overlap. |
| Dark mode | TBD | TBD | TBD | Semantic tokens readable. |
```

**Step 2: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
```

**Step 3: Verify route and link behavior.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase3-qa.md -->

## Link Checks

- [ ] Back link returns to `/workspace/leads-customers`.
- [ ] Opportunity Details links preserve current lead route and add only `opportunityId`.
- [ ] Meeting links open in a new tab with `rel="noreferrer"`.
- [ ] Cmd/Ctrl-click works on row/action links.
```

**Key implementation notes:**
- Fix text overflow with layout constraints and wrapping, not viewport-scaled fonts.
- If the detail payload is too large, adjust Phase 1 caps and section contracts before shipping.
- Do not hide sections behind tabs to reduce page length.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/phase3-qa.md` | Create | Detail QA evidence |
| `app/workspace/leads-customers/[leadId]/**` | Modify | Only for QA fixes |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/leads-customers/[leadId]/page.tsx` | Create | 3A |
| `app/workspace/leads-customers/[leadId]/loading.tsx` | Create | 3A |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-skeleton.tsx` | Create | 3A |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-page-client.tsx` | Create | 3B |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-context.tsx` | Create | 3B |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-layout.tsx` | Create | 3B |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-empty-states.tsx` | Create | 3B |
| `app/workspace/leads-customers/[leadId]/_components/entity-header-section.tsx` | Create | 3C |
| `app/workspace/leads-customers/[leadId]/_components/entity-identity-chain.tsx` | Create | 3C |
| `app/workspace/leads-customers/[leadId]/_components/entity-detail-formatters.ts` | Create | 3C |
| `app/workspace/leads-customers/[leadId]/_components/entity-opportunities-section.tsx` | Create | 3D |
| `app/workspace/leads-customers/[leadId]/_components/entity-opportunity-row.tsx` | Create | 3D |
| `app/workspace/leads-customers/[leadId]/_components/entity-payments-section.tsx` | Create | 3D |
| `app/workspace/leads-customers/[leadId]/_components/entity-meetings-section.tsx` | Create | 3E |
| `app/workspace/leads-customers/[leadId]/_components/entity-meeting-row.tsx` | Create | 3E |
| `app/workspace/leads-customers/[leadId]/_components/entity-comments-list.tsx` | Create | 3E |
| `app/workspace/leads-customers/[leadId]/_components/entity-activity-section.tsx` | Create | 3F |
| `app/workspace/leads-customers/[leadId]/_components/entity-fields-identifiers-section.tsx` | Create | 3F |
| `app/workspace/leads-customers/[leadId]/_components/entity-attribution-grid.tsx` | Create | 3F |
| `plans/leads-customers-unified-view/phase3-qa.md` | Create | 3G |
