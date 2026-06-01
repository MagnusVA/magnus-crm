# Phase 5 - Frontend: Opportunity Detail & Side-Deal Payment Flow

**Goal:** Add `/workspace/opportunities/[opportunityId]` as the canonical opportunity detail page for both Calendly-sourced and side-deal opportunities, with side-deal-specific actions to record payment or mark lost. After this phase, a user can create a side-deal opportunity, open its detail page, record payment, and see payments/activity update reactively.

**Prerequisite:** Phase 2 `sideDeals.logPayment`, `sideDeals.markLost`, and Phase 3/4 route entry points are implemented. Phase 6 void UI is not required for this phase; detail page reserves permission/action space for it.

**Runs in PARALLEL with:** Phase 3 and Phase 4 after Phase 2 signatures stabilize. This phase owns `/workspace/opportunities/[opportunityId]/*` and only shares `app/workspace/_components/pipeline/opportunities-table.tsx` with existing pipeline UI.

**Skills to invoke:**
- `frontend-design` - build a dense CRM detail page with clear hierarchy, no marketing composition, and stable action placement.
- `next-best-practices` - use async `params`, `unstable_instant = false`, and server Convex preflight without leaking inaccessible rows.
- `shadcn` - compose Card, Dialog, AlertDialog, Form, Alert, Badge, Table/list primitives consistently.
- `web-design-guidelines` - verify dialog focus, form labels, error messaging, and empty-state accessibility.

---

## Acceptance Criteria

1. Navigating to `/workspace/opportunities/{id}` renders an opportunity detail page for authorized admins and assigned closers.
2. Unauthorized closer access returns `notFound()` during RSC preflight or an inline unavailable state after hydration; no cross-tenant or cross-closer details leak.
3. Calendly-sourced opportunities render meetings normally and do not show the side-deal payment button.
4. Side-deal opportunities render a "No meetings" empty state and show "Record payment" while status is `in_progress`.
5. Recording a side-deal payment uploads optional proof, calls `api.sideDeals.logPayment.logPayment`, shows success toast, closes the dialog, and the detail page updates through Convex reactivity.
6. Side-deal payment form uses the same field semantics as the existing meeting payment dialog: amount, currency, program, payment type, optional proof file with 10 MB/MIME validation.
7. Mark lost calls `api.sideDeals.markLost.markLost`, supports optional reason, and hides payment/lost actions after success.
8. Payments section shows side-deal payments with amount, program, payment type, origin, status, and recorded date.
9. Pipeline table "View" actions and row behavior route to `/workspace/opportunities/{id}` instead of dead-ending side deals with no meeting.
10. All detail sections are wrapped or isolated so a payments/timeline render error does not break the full page.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (detail query backend - BLOCKER) ──────────────┐
                                                  │
5B (route wrapper + skeleton) ────────────────────┼── 5C (detail client + sections) ───┐
                                                  │                                     │
5D (payment dialog) ──────────────────────────────┤                                     ├── 5G (QA gate)
                                                  │                                     │
5E (mark lost dialog) ────────────────────────────┘                                     │
                                                                                        │
5F (pipeline table detail navigation) ──────────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start **5A, 5B, 5D, 5E, and 5F in parallel**. 5A defines data contract, 5B owns route scaffolding, dialogs own isolated files, and pipeline integration owns one shared component.
2. Start **5C** once 5A's return shape is stable.
3. Run **5G** after all route/action files merge.

**Estimated time:** 2-3 days solo, or 1.5 days with backend query, detail layout, dialogs, and pipeline integration split.

---

## Subphases

### 5A - Opportunity Detail Query

**Type:** Backend
**Parallelizable:** Yes - owns a new query file and defines the data contract for 5C.

**What:** Create `api.opportunities.detailQuery.getOpportunityDetail`.

**Why:** The detail route needs one tenant/role-scoped query that returns all sections in a bounded shape: opportunity, lead, closer, meetings, payments, events, and action permissions.

**Where:**
- `convex/opportunities/detailQuery.ts` (new)

**How:**

**Step 1: Implement tenant/role-scoped detail lookup.**

```typescript
// Path: convex/opportunities/detailQuery.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { normalizeOpportunitySource } from "../lib/sideDeals";

export const getOpportunityDetail = query({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) return null;
    if (!isAdmin && opportunity.assignedCloserId !== userId) return null;

    const [lead, closer, meetings, payments, opportunityEvents] = await Promise.all([
      ctx.db.get(opportunity.leadId),
      opportunity.assignedCloserId ? ctx.db.get(opportunity.assignedCloserId) : Promise.resolve(null),
      ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .order("desc")
        .take(20),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .order("desc")
        .take(50),
      ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q.eq("tenantId", tenantId).eq("entityType", "opportunity").eq("entityId", opportunityId),
        )
        .order("desc")
        .take(50),
    ]);

    const paymentEventsNested = await Promise.all(
      payments.map((payment) =>
        ctx.db
          .query("domainEvents")
          .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
            q.eq("tenantId", tenantId).eq("entityType", "payment").eq("entityId", payment._id),
          )
          .order("desc")
          .take(10),
      ),
    );

    const source = normalizeOpportunitySource(opportunity);
    const isSideDeal = source === "side_deal";
    const events = [...opportunityEvents, ...paymentEventsNested.flat()]
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, 50);

    return {
      opportunity: {
        _id: opportunity._id,
        status: opportunity.status,
        source,
        notes: opportunity.notes,
        assignedCloserId: opportunity.assignedCloserId,
        createdAt: opportunity.createdAt,
        updatedAt: opportunity.updatedAt,
        latestActivityAt: opportunity.latestActivityAt,
        paymentReceivedAt: opportunity.paymentReceivedAt,
        lostAt: opportunity.lostAt,
        lostReason: opportunity.lostReason,
      },
      lead: lead && lead.tenantId === tenantId
        ? {
            _id: lead._id,
            fullName: lead.fullName,
            email: lead.email,
            phone: lead.phone,
            status: lead.status,
          }
        : null,
      closer: closer && closer.tenantId === tenantId
        ? {
            _id: closer._id,
            fullName: closer.fullName,
            email: closer.email,
          }
        : null,
      meetings: meetings.map((meeting) => ({
        _id: meeting._id,
        status: meeting.status,
        scheduledAt: meeting.scheduledAt,
        callClassification: meeting.callClassification,
      })),
      payments: payments.map((payment) => ({
        _id: payment._id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        programName: payment.programName,
        paymentType: payment.paymentType,
        status: payment.status,
        origin: payment.origin,
        recordedAt: payment.recordedAt,
      })),
      events: events.map((event) => ({
        _id: event._id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reason: event.reason,
      })),
      permissions: {
        viewerUserId: userId,
        canRecordPayment: isSideDeal && opportunity.status === "in_progress",
        canMarkLost: isSideDeal && opportunity.status === "in_progress",
        canVoidPayment: false,
        canDeleteOpportunity: false,
      },
    };
  },
});
```

**Key implementation notes:**
- Return `null` for unauthorized access. Do not throw with details that distinguish missing vs forbidden.
- Keep all lists bounded: meetings 20, payments 50, events 50.
- Phase 6 will update `canVoidPayment`; Phase 7 will update `canDeleteOpportunity` and stale-nudge fields.
- If `domainEvents.entityId` is stored as string, `v.id("opportunities")` is still assignable to string; keep the query exact.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/opportunities/detailQuery.ts` | Create | Detail payload and action permissions. |

---

### 5B - Detail Route Wrapper and Skeleton

**Type:** Frontend
**Parallelizable:** Yes - owns route and skeleton files.

**What:** Create the dynamic detail route with server preflight and a stable loading skeleton.

**Why:** The server should reject missing/inaccessible rows before streaming when possible, while the client subscription keeps the page live after hydration.

**Where:**
- `app/workspace/opportunities/[opportunityId]/page.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/loading.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-skeleton.tsx` (new)

**How:**

**Step 1: Add RSC preflight with async params.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/page.tsx
import { Suspense } from "react";
import { fetchQuery } from "convex/nextjs";
import { notFound } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { verifySession } from "@/lib/auth";
import { OpportunityDetailClient } from "./_components/opportunity-detail-client";
import { OpportunityDetailSkeleton } from "./_components/opportunity-detail-skeleton";

export const unstable_instant = false;

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ opportunityId: string }>;
}) {
  const { opportunityId } = await params;
  const { accessToken } = await verifySession();
  const initial = await fetchQuery(
    api.opportunities.detailQuery.getOpportunityDetail,
    { opportunityId: opportunityId as Id<"opportunities"> },
    { token: accessToken },
  );
  if (initial === null) notFound();

  return (
    <Suspense fallback={<OpportunityDetailSkeleton />}>
      <OpportunityDetailClient opportunityId={opportunityId as Id<"opportunities">} />
    </Suspense>
  );
}
```

**Step 2: Add loading route.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/loading.tsx
import { OpportunityDetailSkeleton } from "./_components/opportunity-detail-skeleton";

export default function OpportunityDetailLoading() {
  return <OpportunityDetailSkeleton />;
}
```

**Step 3: Add skeleton.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-skeleton.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OpportunityDetailSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6" role="status" aria-label="Loading opportunity detail">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      {[0, 1, 2].map((index) => (
        <Card key={index}>
          <CardHeader><Skeleton className="h-5 w-36" /></CardHeader>
          <CardContent><Skeleton className="h-24 w-full" /></CardContent>
        </Card>
      ))}
    </div>
  );
}
```

**Key implementation notes:**
- `params` is a Promise in Next.js 16; always await it.
- The RSC preflight does not pass `initial` into the client in MVP; the client uses a live `useQuery`. If first-paint performance becomes a problem, switch to `preloadQuery`/`usePreloadedQuery`.
- `verifySession()` is enough for token acquisition; Convex query still enforces tenant/role.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/page.tsx` | Create | Dynamic route with RSC preflight. |
| `app/workspace/opportunities/[opportunityId]/loading.tsx` | Create | Route loading file. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-skeleton.tsx` | Create | Stable skeleton. |

---

### 5C - Detail Client and Read-Only Sections

**Type:** Frontend
**Parallelizable:** Yes after 5A return shape is stable.

**What:** Build the detail page layout, summary, meetings, payments, and activity timeline.

**Why:** This page is the single source of truth for side deals and the new first-class opportunity entity.

**Where:**
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` (new)

**How:**

**Step 1: Add detail client layout.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx
"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { CalendarXIcon, ChevronLeftIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OpportunitySourceBadge } from "../../_components/opportunity-source-badge";
import { MarkSideDealLostDialog } from "./mark-side-deal-lost-dialog";
import { OpportunityActivityTimeline } from "./opportunity-activity-timeline";
import { OpportunityMeetingsList } from "./opportunity-meetings-list";
import { OpportunityPaymentsList } from "./opportunity-payments-list";
import { SideDealPaymentDialog } from "./side-deal-payment-dialog";

export function OpportunityDetailClient({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const data = useQuery(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId });
  if (data === undefined) return null;
  if (data === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Opportunity unavailable</CardTitle>
          <CardDescription>It may have been deleted, reassigned, or moved outside your access.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { opportunity, lead, closer, meetings, payments, events, permissions } = data;
  const isSideDeal = opportunity.source === "side_deal";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3 mb-2">
          <Link href="/workspace/opportunities">
            <ChevronLeftIcon data-icon="inline-start" />
            All opportunities
          </Link>
        </Button>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{lead?.fullName ?? lead?.email ?? "Unknown lead"}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <OpportunitySourceBadge source={opportunity.source} />
              <Badge>{opportunity.status.replaceAll("_", " ")}</Badge>
              {lead?.email ? <span className="text-sm text-muted-foreground">{lead.email}</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {permissions.canRecordPayment ? <SideDealPaymentDialog opportunityId={opportunity._id} /> : null}
            {permissions.canMarkLost ? <MarkSideDealLostDialog opportunityId={opportunity._id} /> : null}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Summary</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <SummaryField label="Assigned closer" value={closer?.fullName ?? closer?.email ?? "Unassigned"} />
          <SummaryField label="Created" value={formatDistanceToNow(new Date(opportunity.createdAt), { addSuffix: true })} />
          <SummaryField label="Last activity" value={formatDistanceToNow(new Date(opportunity.latestActivityAt ?? opportunity.updatedAt), { addSuffix: true })} />
          {opportunity.notes ? (
            <div className="sm:col-span-3">
              <div className="text-xs text-muted-foreground">Notes</div>
              <div className="whitespace-pre-wrap text-sm">{opportunity.notes}</div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <SectionErrorBoundary sectionName="Meetings">
        <Card>
          <CardHeader><CardTitle className="text-base">Meetings</CardTitle></CardHeader>
          <CardContent>
            {isSideDeal ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <CalendarXIcon className="size-6 text-muted-foreground" />
                <div className="text-sm font-medium">No meetings</div>
                <div className="max-w-sm text-xs text-muted-foreground">
                  This opportunity was created manually as a side deal and has no Calendly meetings.
                </div>
              </div>
            ) : (
              <OpportunityMeetingsList meetings={meetings} />
            )}
          </CardContent>
        </Card>
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="Payments">
        <OpportunityPaymentsList payments={payments} />
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="Activity">
        <OpportunityActivityTimeline events={events} />
      </SectionErrorBoundary>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
```

**Step 2: Add payments list.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function OpportunityPaymentsList({
  payments,
}: {
  payments: Array<{
    _id: string;
    amountMinor: number;
    currency: string;
    programName: string;
    paymentType: string;
    status: string;
    origin: string;
    recordedAt: number;
  }>;
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Payments</CardTitle></CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
        ) : (
          <div className="flex flex-col divide-y">
            {payments.map((payment) => (
              <div key={payment._id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">
                    {(payment.amountMinor / 100).toLocaleString(undefined, { style: "currency", currency: payment.currency })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {payment.programName} · {payment.paymentType.replaceAll("_", " ")} · {format(new Date(payment.recordedAt), "MMM d, yyyy")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{payment.origin.replaceAll("_", " ")}</Badge>
                  <Badge>{payment.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- Reuse the Phase 3 source badge via relative import; do not duplicate label logic.
- Keep action buttons in the header, not buried in sections.
- The detail page should not try to edit lead/program/amount in MVP.
- `SectionErrorBoundary` is already a workspace component; use it around independent sections.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Create | Main detail layout and actions. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Create | Calendly meeting list for non-side-deals. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` | Create | Payment display. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` | Create | Domain event timeline. |

---

### 5D - SideDealPaymentDialog

**Type:** Frontend
**Parallelizable:** Yes - owns an isolated dialog file, depends on Phase 2 mutation.

**What:** Add a side-deal payment dialog that mirrors the existing meeting payment form but calls `api.sideDeals.logPayment.logPayment`.

**Why:** Recording payment is what turns a manually created opportunity into side-deal revenue. This must reuse the same validation and program/payment-type semantics users already know.

**Where:**
- `app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog.tsx` (new)

**How:**

**Step 1: Implement form schema and mutation wiring.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog.tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { BanknoteIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_FILE_TYPES = ["image/jpeg", "image/png", "image/gif", "application/pdf"];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
const PAYMENT_TYPES = ["monthly", "split", "pif", "deposit"] as const;

const paymentSchema = z.object({
  amount: z.string().min(1, "Amount is required").refine((value) => Number(value) > 0, "Amount must be greater than 0"),
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Please select a program"),
  paymentType: z.enum(PAYMENT_TYPES, { error: "Please select a payment type" }),
  proofFile: z
    .instanceof(File)
    .optional()
    .refine((file) => !file || file.size <= MAX_FILE_SIZE, "File size must be less than 10 MB")
    .refine((file) => !file || VALID_FILE_TYPES.includes(file.type), "Only images and PDFs are allowed"),
});
type PaymentValues = z.infer<typeof paymentSchema>;

export function SideDealPaymentDialog({ opportunityId }: { opportunityId: Id<"opportunities"> }) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, open ? { includeArchived: false } : "skip");
  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.sideDeals.logPayment.logPayment);

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      programId: "",
      paymentType: undefined,
      proofFile: undefined,
    },
  });
```

**Step 2: Add upload + submit behavior.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog.tsx
  const onSubmit = async (values: PaymentValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      let proofFileId: Id<"_storage"> | undefined;
      if (values.proofFile) {
        const uploadUrl = await generateUploadUrl();
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": values.proofFile.type },
          body: values.proofFile,
        });
        if (!uploadResponse.ok) throw new Error("Failed to upload proof file");
        const uploadData = (await uploadResponse.json()) as { storageId?: string };
        if (!uploadData.storageId) throw new Error("File upload returned invalid storage ID");
        proofFileId = uploadData.storageId as Id<"_storage">;
      }

      const result = await logPayment({
        opportunityId,
        amount: Number(values.amount),
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
      });

      posthog.capture("side_deal_payment_logged", {
        opportunity_id: opportunityId,
        payment_id: result.paymentId,
        has_proof_file: Boolean(proofFileId),
      });
      toast.success("Payment recorded");
      form.reset();
      setOpen(false);
    } catch (error) {
      posthog.captureException(error);
      setSubmitError(error instanceof Error ? error.message : "Failed to record payment");
    } finally {
      setIsSubmitting(false);
    }
  };
```

**Key implementation notes:**
- Use `api.closer.payments.generateUploadUrl`; it already authorizes all tenant roles that can log payment.
- The dialog should query programs only when open.
- Consider extracting shared payment fields from the existing meeting payment dialog only if it does not create a cross-route import cycle. Duplication is acceptable for MVP if the field set is identical and small.
- A proof upload orphan is accepted for MVP if the mutation fails after upload.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog.tsx` | Create | Payment form for side-deal opportunities. |

---

### 5E - MarkSideDealLostDialog

**Type:** Frontend
**Parallelizable:** Yes - owns an isolated dialog file.

**What:** Add a mark-lost action for in-progress side-deal opportunities.

**Why:** Not every manually created side deal becomes a payment. Users need a terminal path that reverses active opportunity counts and records audit context.

**Where:**
- `app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog.tsx` (new)

**How:**

**Step 1: Implement alert dialog with optional reason.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog.tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";

const schema = z.object({
  reason: z.string().max(500).optional().or(z.literal("")),
});
type Values = z.infer<typeof schema>;

export function MarkSideDealLostDialog({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markLost = useMutation(api.sideDeals.markLost.markLost);
  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: Values) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await markLost({ opportunityId, reason: values.reason?.trim() || undefined });
      posthog.capture("side_deal_marked_lost", { opportunity_id: opportunityId });
      toast.success("Opportunity marked lost");
      setOpen(false);
      form.reset();
    } catch (err) {
      posthog.captureException(err);
      setError(err instanceof Error ? err.message : "Failed to mark lost");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(value) => !isSubmitting && setOpen(value)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">Mark lost</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark this opportunity lost?</AlertDialogTitle>
          <AlertDialogDescription>
            This closes the side-deal opportunity without recording payment.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (optional)</FormLabel>
                  <FormControl><Textarea rows={3} {...field} disabled={isSubmitting} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={isSubmitting}>Mark lost</Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Key implementation notes:**
- This mirrors existing `mark-lost-dialog.tsx` patterns but targets side-deal opportunity ids instead of meeting ids.
- Keep reason optional; backend trims.
- If shadcn `AlertDialogAction` cannot submit nested RHF forms cleanly, use a normal `Button type="submit"` inside the form as shown.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog.tsx` | Create | Side-deal lost action. |

---

### 5F - Pipeline Table Detail Navigation

**Type:** Frontend
**Parallelizable:** Yes - owns one existing table component and should be coordinated with any active pipeline work.

**What:** Update the shared pipeline `OpportunitiesTable` so every row/action can open the new opportunity detail page.

**Why:** Pipeline remains workflow-focused, but opportunity detail becomes the canonical entity view. Side deals have no meeting id, so the old "View meeting" action is insufficient.

**Where:**
- `app/workspace/_components/pipeline/opportunities-table.tsx` (modify)
- `app/workspace/pipeline/_components/pipeline-page-client.tsx` (modify if prop contract changes)
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` (modify if prop contract changes)

**How:**

**Step 1: Add an opportunity detail action target without removing meeting links abruptly.**

```tsx
// Path: app/workspace/_components/pipeline/opportunities-table.tsx
export interface OpportunitiesTableProps {
  opportunities: PipelineOpportunity[];
  canLoadMore: boolean;
  isLoadingMore?: boolean;
  onLoadMore: () => void;
  showCloserColumn?: boolean;
  meetingBasePath: string;
  opportunityBasePath?: string;
  emptyState?: React.ReactNode;
}

// In the row action:
<Button variant="ghost" size="sm" asChild aria-label={`View opportunity for ${opp.leadName}`}>
  <Link href={`${opportunityBasePath ?? "/workspace/opportunities"}/${opp._id}`}>
    View
    <ExternalLinkIcon data-icon="inline-end" />
  </Link>
</Button>
```

**Step 2: Keep meeting links available only if the row explicitly needs them.**

```tsx
// Path: app/workspace/_components/pipeline/opportunities-table.tsx
// Optional future split:
// - Primary row/action goes to opportunity detail.
// - A secondary "Meeting" link appears when targetMeetingId exists.
// MVP can simply make "View" route to opportunity detail and let the
// detail page expose linked meetings.
```

**Key implementation notes:**
- Prefer opportunity detail as the primary action for all rows.
- Do not break `meetingBasePath` until both admin and closer pipeline pages are updated. It can remain as a prop during transition.
- Row click should not conflict with nested links. If the whole row becomes clickable, stop propagation on buttons.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/pipeline/opportunities-table.tsx` | Modify | Primary action routes to opportunity detail. |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Modify / Optional | Pass `opportunityBasePath` if prop is added. |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Modify / Optional | Pass `opportunityBasePath` if prop is added. |

---

### 5G - Detail Flow QA Gate

**Type:** Manual / Full-Stack
**Parallelizable:** No - runs after detail query, route, dialogs, and pipeline integration merge.

**What:** Verify end-to-end create -> detail -> payment and Calendly detail read-only behavior.

**Why:** This is the first point where all side-deal pieces are user-complete.

**Where:**
- Terminal
- Local browser
- Convex dashboard

**How:**

**Step 1: Static checks.**

```bash
# Path: repo root
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Browser flow checks.**

```bash
# Path: repo root
pnpm dev
```

Verify:
- Create an opportunity, land on detail page, and see no meetings.
- Record payment without proof file, then with a small proof file in a second test opportunity.
- Payments section updates and action buttons disappear after payment.
- Mark lost on a fresh side-deal opportunity and verify actions disappear.
- Open a Calendly-sourced opportunity and confirm meetings render and no side-deal payment button appears.
- Closer cannot open another closer's opportunity detail.
- Pipeline "View" opens the new opportunity detail.

**Step 3: Data checks in Convex dashboard.**

```typescript
// Path: Convex dashboard
// Confirm side-deal payment rows:
// meetingId === undefined
// origin === "closer_side_deal" or "admin_side_deal"
// contextType === "opportunity"
// opportunity.status === "payment_received"
```

**Key implementation notes:**
- Test both admin and closer payment logging because origin differs.
- Test at mobile width. Dialog fields must not overflow; footer buttons can stack.
- Any impossible state in detail query should render a quiet unavailable/empty state, not a thrown client error.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Verification only. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/opportunities/detailQuery.ts` | Create | 5A |
| `app/workspace/opportunities/[opportunityId]/page.tsx` | Create | 5B |
| `app/workspace/opportunities/[opportunityId]/loading.tsx` | Create | 5B |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-skeleton.tsx` | Create | 5B |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Create | 5C |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Create | 5C |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` | Create | 5C |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` | Create | 5C |
| `app/workspace/opportunities/[opportunityId]/_components/side-deal-payment-dialog.tsx` | Create | 5D |
| `app/workspace/opportunities/[opportunityId]/_components/mark-side-deal-lost-dialog.tsx` | Create | 5E |
| `app/workspace/_components/pipeline/opportunities-table.tsx` | Modify | 5F |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Modify / Optional | 5F |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Modify / Optional | 5F |
