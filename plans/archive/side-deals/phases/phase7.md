# Phase 7 - Staleness Detection, Nudges & Empty-Opportunity Cleanup

**Goal:** Prevent abandoned side-deal opportunities from inflating active pipeline numbers forever. This phase adds stale side-deal nudges, a safe hard-delete path for truly empty side-deal opportunities, and UI affordances to resolve stale records by paying, marking lost, or deleting.

**Prerequisite:** Phase 5 detail page exists. Phase 6 void semantics are understood. Phase 1 added `by_source_and_status_and_createdAt` on opportunities, which the stale scan uses.

**Runs in PARALLEL with:** Reporting-only parts of Phase 6 can run concurrently. Detail-page UI edits in 7E must be sequenced after Phase 6's void UI to avoid conflicts in `opportunity-detail-client.tsx` and `detailQuery.ts`.

**Skills to invoke:**
- `convex-performance-audit` - verify cron scans are batched, indexed, idempotent, and do not loop over skipped rows indefinitely.
- `convex-migration-helper` - confirm schema additions are additive and require no backfill.
- `frontend-design` - keep stale indicators subtle and operational, not alarmist.
- `web-design-guidelines` - verify destructive delete dialog language and accessible alert/banner behavior.

---

## Acceptance Criteria

1. `npx convex dev` accepts the additive `followUps.reason = "stale_opportunity_nudge"` literal and `by_opportunityId_and_status_and_reason` index.
2. `nudgeStaleSideDeals` scans only `source: "side_deal"`, `status: "in_progress"` opportunities older than 72 hours using an indexed, paginated query.
3. The cron creates at most one pending stale nudge per qualifying opportunity, even when run repeatedly.
4. Opportunities with any payment, meeting, or real follow-up are not nudged.
5. Stale nudges appear in the existing closer Reminders surface as `type: "manual_reminder"`, `createdSource: "system"`, assigned to the opportunity closer.
6. Clicking a stale nudge in Reminders routes to `/workspace/opportunities/{opportunityId}`; generic reminder outcome actions are hidden or redirected for `reason: "stale_opportunity_nudge"`.
7. Recording payment or marking lost expires pending stale nudges for that opportunity.
8. `deleteEmptyOpportunity` hard-deletes only side-deal opportunities in `in_progress` with zero payments, zero meetings, and no follow-ups except stale nudges.
9. Deleting an empty opportunity deletes stale-nudge follow-ups, deletes the opportunity aggregate row, reverses `totalOpportunities` and `activeOpportunities`, and emits `opportunity.deleted`.
10. Detail page shows a stale banner and Delete button only when backend permission flags allow it.
11. Opportunities list can show a subtle stale badge without additional client queries.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
7A (schema + index - BLOCKER) ───────────────────────────┐
                                                         │
                ┌────────────────────────────────────────┘
                │
                ├── 7B (staleness cron + internal mutation) ─────┐
                │                                                │
                ├── 7C (deleteEmptyOpportunity mutation) ────────┤
                │                                                ├── 7D (query/action integration)
                └── 7E (UI dialog/banner/table badge shell) ─────┘
                                                                 │
                                                                 └── 7F (QA gate)
```

**Optimal execution:**
1. Start **7A** first. It is a generated-type blocker for `followUps.reason`.
2. Run **7B, 7C, and 7E in parallel** after schema deploys. 7B owns cron/internal mutation, 7C owns deletion mutation, 7E can scaffold UI against planned permission fields.
3. Run **7D** after 7B/7C define exact nudge and permission semantics.
4. Run **7F** after backend and UI merge.

**Estimated time:** 2 days solo, or 1.25 days with cron, deletion, and UI split.

---

## Subphases

### 7A - Follow-Up Schema Additions

**Type:** Backend
**Parallelizable:** No - generated `Doc<"followUps">["reason"]` must include the new literal before backend code compiles.

**What:** Add the stale-nudge follow-up reason and idempotency lookup index.

**Why:** Stale side-deal nudges reuse the existing reminders/follow-ups table. A new reason literal distinguishes system nudges from user-created work.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the reason literal.**

```typescript
// Path: convex/schema.ts
reason: v.union(
  v.literal("closer_initiated"),
  v.literal("cancellation_follow_up"),
  v.literal("no_show_follow_up"),
  v.literal("admin_initiated"),
  v.literal("overran_review_resolution"),
  v.literal("stale_opportunity_nudge"),
),
```

**Step 2: Add the idempotency index.**

```typescript
// Path: convex/schema.ts
.index("by_opportunityId_and_status_and_reason", [
  "opportunityId",
  "status",
  "reason",
])
```

**Step 3: Deploy schema and typecheck.**

```bash
# Path: repo root
npx convex dev
pnpm tsc --noEmit
```

**Key implementation notes:**
- This is additive; no migration or backfill is needed.
- Do not add a new follow-up table. Existing reminder views already consume `followUps`.
- Keep the index name complete and ordered exactly by fields per Convex guidelines.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add follow-up reason literal and index. |

---

### 7B - Staleness Cron and Internal Mutation

**Type:** Backend
**Parallelizable:** Yes - owns `convex/opportunities/staleness.ts` and `convex/crons.ts`.

**What:** Add `internal.opportunities.staleness.nudgeStaleSideDeals` and schedule it every six hours.

**Why:** Closers need explicit nudges for side-deal opportunities that have sat for 72 hours without any real work attached.

**Where:**
- `convex/opportunities/staleness.ts` (new)
- `convex/crons.ts` (modify)

**How:**

**Step 1: Implement the internal mutation.**

```typescript
// Path: convex/opportunities/staleness.ts
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { isSideDeal } from "../lib/sideDeals";

const STALE_THRESHOLD_MS = 72 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

export const nudgeStaleSideDeals = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    cutoff: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = args.cutoff ?? now - STALE_THRESHOLD_MS;

    const page = await ctx.db
      .query("opportunities")
      .withIndex("by_source_and_status_and_createdAt", (q) =>
        q.eq("source", "side_deal").eq("status", "in_progress").lt("createdAt", cutoff),
      )
      .order("asc")
      .paginate({ numItems: BATCH_SIZE, cursor: args.cursor ?? null });

    let nudged = 0;
    for (const candidate of page.page) {
      const opportunity = await ctx.db.get(candidate._id);
      if (!opportunity || !isSideDeal(opportunity) || opportunity.status !== "in_progress") continue;
      if (!opportunity.assignedCloserId) continue;

      const [payment, meeting, followUps, pendingNudge] = await Promise.all([
        ctx.db
          .query("paymentRecords")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
          .first(),
        ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
          .first(),
        ctx.db
          .query("followUps")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
          .take(50),
        ctx.db
          .query("followUps")
          .withIndex("by_opportunityId_and_status_and_reason", (q) =>
            q
              .eq("opportunityId", opportunity._id)
              .eq("status", "pending")
              .eq("reason", "stale_opportunity_nudge"),
          )
          .first(),
      ]);

      if (payment || meeting || pendingNudge) continue;
      if (followUps.length === 50) continue;
      if (followUps.some((followUp) => followUp.reason !== "stale_opportunity_nudge")) continue;

      const ageHours = Math.floor((now - opportunity.createdAt) / (60 * 60 * 1000));
      await ctx.db.insert("followUps", {
        tenantId: opportunity.tenantId,
        opportunityId: opportunity._id,
        leadId: opportunity.leadId,
        closerId: opportunity.assignedCloserId,
        type: "manual_reminder",
        reason: "stale_opportunity_nudge",
        status: "pending",
        reminderScheduledAt: now,
        reminderNote:
          `This side-deal opportunity has been sitting for ${ageHours}h without activity. ` +
          `Record payment, mark it lost, or delete it if it was created by mistake.`,
        createdAt: now,
        createdSource: "system",
      });

      await emitDomainEvent(ctx, {
        tenantId: opportunity.tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.stale_flagged",
        source: "system",
        occurredAt: now,
        metadata: {
          source: "side_deal",
          ageMs: now - opportunity.createdAt,
          thresholdMs: STALE_THRESHOLD_MS,
        },
      });
      nudged += 1;
    }

    console.log("[Opportunities:Staleness] scanned=%d nudged=%d", page.page.length, nudged);

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.opportunities.staleness.nudgeStaleSideDeals, {
        cursor: page.continueCursor,
        cutoff,
      });
    }

    return null;
  },
});
```

**Step 2: Register the cron.**

```typescript
// Path: convex/crons.ts
crons.interval(
  "nudge-stale-side-deals",
  { hours: 6 },
  internal.opportunities.staleness.nudgeStaleSideDeals,
  {},
);
```

**Key implementation notes:**
- The scan is tenant-agnostic but source/status indexed. That is acceptable because it is internal, batched, and bounded.
- Do not auto-mark lost. The closer must choose payment, lost, or delete.
- Skip rows with `followUps.length === 50` rather than risking incomplete emptiness checks.
- The strict predicate is `createdAt < now - 72h`; exactly 72h waits until the next tick.
- Keep the first invocation's `cutoff` fixed across recursive batches. Do not recompute the cutoff while resuming a cursor.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/opportunities/staleness.ts` | Create | Internal stale-nudge mutation. |
| `convex/crons.ts` | Modify | Add six-hour cron. |

---

### 7C - Delete Empty Side-Deal Opportunity Mutation

**Type:** Backend
**Parallelizable:** Yes - owns a new sideDeals mutation.

**What:** Create `api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity`.

**Why:** Some side-deal opportunities are accidental and have no business value. Hard deletion is safe only when there are no payments, meetings, or real follow-up work.

**Where:**
- `convex/sideDeals/deleteEmptyOpportunity.ts` (new)

**How:**

**Step 1: Implement strict emptiness checks and delete.**

```typescript
// Path: convex/sideDeals/deleteEmptyOpportunity.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { isSideDeal } from "../lib/sideDeals";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { opportunityByStatus } from "../reporting/aggregates";

export const deleteEmptyOpportunity = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { opportunityId, reason }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const now = Date.now();

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) throw new Error("Opportunity not found.");
    if (!isSideDeal(opportunity)) throw new Error("Only side-deal opportunities can be deleted.");
    if (opportunity.status !== "in_progress") {
      throw new Error(`Cannot delete an opportunity in '${opportunity.status}' status.`);
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      throw new Error("You are not the assigned closer for this opportunity.");
    }

    const [payment, meeting, bookedFollowUp, completedFollowUp, followUps] = await Promise.all([
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .first(),
      ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .first(),
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status", (q) =>
          q.eq("opportunityId", opportunityId).eq("status", "booked"),
        )
        .first(),
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status", (q) =>
          q.eq("opportunityId", opportunityId).eq("status", "completed"),
        )
        .first(),
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
        .take(50),
    ]);

    if (payment) throw new Error("This opportunity has a payment record. Void the payment first, or mark it lost.");
    if (meeting) throw new Error("This opportunity has a meeting attached. Mark it lost instead.");
    if (bookedFollowUp || completedFollowUp) throw new Error("This opportunity has follow-up work attached. Mark it lost instead.");
    if (followUps.length === 50) throw new Error("Too many follow-ups are attached to delete safely.");
    if (followUps.some((followUp) => followUp.reason !== "stale_opportunity_nudge")) {
      throw new Error("This opportunity has a follow-up attached. Mark it lost instead.");
    }

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.deleted",
      source: isAdmin ? "admin" : "closer",
      actorUserId: userId,
      reason: reason?.trim() || undefined,
      occurredAt: now,
      metadata: {
        source: "side_deal",
        ageMs: now - opportunity.createdAt,
        assignedCloserId: opportunity.assignedCloserId,
      },
    });

    for (const followUp of followUps) {
      await ctx.db.delete(followUp._id);
    }
    await opportunityByStatus.delete(ctx, opportunity);
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: -1,
      activeOpportunities: -1,
    });
    await ctx.db.delete(opportunityId);

    return null;
  },
});
```

**Key implementation notes:**
- Audit event is emitted before deleting the opportunity.
- Do not delete the lead. A lead can survive even if the accidental opportunity is removed.
- Hard-delete only stale-nudge follow-ups. Any real follow-up blocks deletion.
- `opportunityByStatus.delete(ctx, opportunity)` relies on the aggregate helper accepting the old doc shape; verify against current `@convex-dev/aggregate` API.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/sideDeals/deleteEmptyOpportunity.ts` | Create | Safe hard-delete path for empty side-deal opportunities. |

---

### 7D - Query and Mutation Integration

**Type:** Backend
**Parallelizable:** No - depends on 7B/7C semantics.

**What:** Return stale flags/permissions from queries and expire stale nudges when opportunities are resolved.

**Why:** The UI should not issue extra nudge queries, and reminders must not remain pending after a closer resolves the opportunity.

**Where:**
- `convex/opportunities/detailQuery.ts` (modify)
- `convex/opportunities/listQueries.ts` (modify)
- `convex/sideDeals/logPayment.ts` (modify)
- `convex/sideDeals/markLost.ts` (modify)

**How:**

**Step 1: Add a reusable nudge expiry helper.**

```typescript
// Path: convex/sideDeals/logPayment.ts
async function expirePendingStaleNudges(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const nudges = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q
        .eq("opportunityId", opportunityId)
        .eq("status", "pending")
        .eq("reason", "stale_opportunity_nudge"),
    )
    .take(50);

  for (const nudge of nudges) {
    await ctx.db.patch(nudge._id, { status: "expired" });
  }
}
```

Move this helper to `convex/lib/staleOpportunityNudges.ts` if both `logPayment.ts` and `markLost.ts` need it.

**Step 2: Call expiry in payment/lost mutations.**

```typescript
// Path: convex/sideDeals/markLost.ts
await patchOpportunityLifecycle(ctx, opportunityId, {
  status: "lost",
  lostAt: now,
  lostByUserId: userId,
  lostReason: trimmed,
  updatedAt: now,
});
await expirePendingStaleNudges(ctx, opportunityId);
```

**Step 3: Return stale banner and delete permission from detail query.**

```typescript
// Path: convex/opportunities/detailQuery.ts
const [pendingStaleNudge, attachedFollowUps] = await Promise.all([
  ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q
        .eq("opportunityId", opportunityId)
        .eq("status", "pending")
        .eq("reason", "stale_opportunity_nudge"),
    )
    .first(),
  ctx.db
    .query("followUps")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(50),
]);

const canDeleteOpportunity =
  isSideDeal &&
  opportunity.status === "in_progress" &&
  payments.length === 0 &&
  meetings.length === 0 &&
  attachedFollowUps.length < 50 &&
  attachedFollowUps.every((followUp) => followUp.reason === "stale_opportunity_nudge");
```

**Step 4: Add list-row stale badge flag.**

```typescript
// Path: convex/opportunities/listQueries.ts
async function hasPendingStaleNudge(ctx: QueryCtx, opportunityId: Id<"opportunities">) {
  const nudge = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q
        .eq("opportunityId", opportunityId)
        .eq("status", "pending")
        .eq("reason", "stale_opportunity_nudge"),
    )
    .first();
  return nudge !== null;
}

// In row enrichment:
hasPendingStaleNudge: await hasPendingStaleNudge(ctx, opportunity._id),
```

**Key implementation notes:**
- The list enrichment adds one bounded point query per row. With 25 rows, this is acceptable for MVP. Revisit with denormalization if it becomes hot.
- Do not expire all pending follow-ups when paying/marking lost; expire only stale-opportunity nudges.
- Detail delete permission is only UI guidance. `deleteEmptyOpportunity` rechecks everything.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/staleOpportunityNudges.ts` | Create / Optional | Shared expiry helper. |
| `convex/sideDeals/logPayment.ts` | Modify | Expire stale nudges after payment. |
| `convex/sideDeals/markLost.ts` | Modify | Expire stale nudges after lost. |
| `convex/opportunities/detailQuery.ts` | Modify | Return pending nudge and delete permission. |
| `convex/opportunities/listQueries.ts` | Modify | Add `hasPendingStaleNudge` per row. |

---

### 7E - Stale Banner, Delete Dialog, and List Badge UI

**Type:** Frontend
**Parallelizable:** Yes - can scaffold while backend fields are finalized.

**What:** Add the stale banner, Delete button/dialog on detail, and stale badge on list rows.

**Why:** The cron nudge must lead users to an explicit resolution path. The list indicator helps admins/closers spot stale work without opening every row.

**Where:**
- `app/workspace/closer/_components/reminders-section.tsx` (modify)
- `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` (modify / guard)
- `app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog.tsx` (new)
- `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` (modify)
- `app/workspace/opportunities/_components/opportunities-table.tsx` (modify)

**How:**

**Step 0: Route stale nudges out of the generic reminder outcome flow.**

When a reminder row has `reason === "stale_opportunity_nudge"` and an `opportunityId`, clicking it must open `/workspace/opportunities/{opportunityId}`. Do not route it to `/workspace/closer/reminders/[followUpId]`.

Also guard the reminder detail/action bar for direct URL access: hide or replace the generic payment/no-response/lost reminder outcome actions for stale nudges and show a single action that opens the opportunity detail page. Generic reminder outcome mutations must not record payments or lost outcomes for stale side-deal nudges, because those paths use reminder-origin reporting.

**Step 1: Add delete dialog.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";

const schema = z.object({
  reason: z.string().max(500).optional().or(z.literal("")),
});
type Values = z.infer<typeof schema>;

export function DeleteOpportunityDialog({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const deleteOpportunity = useMutation(api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity);
  const form = useForm({ resolver: standardSchemaResolver(schema), defaultValues: { reason: "" } });

  const onSubmit = async (values: Values) => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteOpportunity({ opportunityId, reason: values.reason?.trim() || undefined });
      posthog.capture("opportunity_deleted", { opportunity_id: opportunityId });
      toast.success("Opportunity deleted");
      router.push("/workspace/opportunities");
    } catch (err) {
      posthog.captureException(err);
      setError(err instanceof Error ? err.message : "Failed to delete opportunity");
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(value) => !submitting && setOpen(value)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2Icon data-icon="inline-start" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this opportunity?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes an empty side-deal opportunity. If payment, meeting, or real follow-up work exists, mark it lost instead.
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
                  <FormControl><Textarea rows={3} {...field} disabled={submitting} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={submitting}>Delete opportunity</Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Step 2: Add stale banner/action to detail page.**

```tsx
// Path: app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DeleteOpportunityDialog } from "./delete-opportunity-dialog";

{data.pendingStaleNudge ? (
  <Alert>
    <AlertDescription>
      This side-deal opportunity has been sitting with no activity. Record payment, mark it lost, or delete it if it was created by mistake.
    </AlertDescription>
  </Alert>
) : null}

{permissions.canDeleteOpportunity ? (
  <DeleteOpportunityDialog opportunityId={opportunity._id} />
) : null}
```

**Step 3: Add list badge.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-table.tsx
{opportunity.hasPendingStaleNudge ? (
  <Badge variant="outline">Stale</Badge>
) : null}
```

**Key implementation notes:**
- The stale banner is informational, not destructive. Keep tone neutral.
- Delete is destructive; require a confirmation dialog even if reason is optional.
- List badge should not add a column if space is tight; it can sit beside source/status badges.
- Reminder rows for stale nudges are navigation affordances, not outcome affordances. Keep side-deal finalization on the opportunity detail page.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/reminders-section.tsx` | Modify | Route stale nudge rows to opportunity detail. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Modify / Guard | Hide generic reminder outcome actions for stale nudges. |
| `app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog.tsx` | Create | Hard-delete confirmation dialog. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Modify | Stale banner and delete action. |
| `app/workspace/opportunities/_components/opportunities-table.tsx` | Modify | Stale row badge. |

---

### 7F - Staleness and Cleanup QA Gate

**Type:** Manual / Full-Stack
**Parallelizable:** No - runs after all staleness code merges.

**What:** Verify cron idempotency, stale banner/list badge, delete invariants, and counter reversals.

**Why:** Cleanup logic is intentionally strict. QA must prove it nudges the right rows and refuses risky deletion.

**Where:**
- Terminal
- Convex dashboard
- Local browser

**How:**

**Step 1: Static checks.**

```bash
# Path: repo root
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Manually seed stale and non-stale side deals in dev.**

```typescript
// Path: Convex dashboard
// Create or patch test opportunities:
// A. side_deal in_progress createdAt = now - 80h, no children -> should nudge
// B. side_deal in_progress createdAt = now - 80h, has payment -> no nudge
// C. calendly scheduled createdAt = now - 80h -> no nudge
// D. side_deal in_progress createdAt = now - 24h -> no nudge
```

**Step 3: Run the internal mutation twice.**

```bash
# Path: repo root
npx convex run opportunities/staleness:nudgeStaleSideDeals '{}'
npx convex run opportunities/staleness:nudgeStaleSideDeals '{}'
```

Verify exactly one pending stale nudge exists for case A.

**Step 4: Browser checks.**

Verify:
- Reminders list stale nudge rows open `/workspace/opportunities/{opportunityId}`, not `/workspace/closer/reminders/[followUpId]`.
- Direct reminder detail access for a stale nudge does not expose generic reminder payment/no-response/lost outcome actions.
- Stale row shows a subtle badge on list.
- Detail shows stale banner.
- Delete succeeds for the empty stale side deal and redirects to list.
- Delete is hidden/rejected for side deal with payment, meeting, or real follow-up.
- Payment/lost resolution expires stale nudge so reminders no longer show it as pending.

**Key implementation notes:**
- The CLI path for internal mutation may require `internal.opportunities.staleness.nudgeStaleSideDeals` depending on Convex CLI version; confirm locally.
- Check tenant stats before/after delete. The net effect of create then delete should be zero for total/active opportunities.
- If cron output keeps scanning the same skipped rows forever, fix cursor scheduling before shipping.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Manual | Verification only. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 7A |
| `convex/opportunities/staleness.ts` | Create | 7B |
| `convex/crons.ts` | Modify | 7B |
| `convex/sideDeals/deleteEmptyOpportunity.ts` | Create | 7C |
| `convex/lib/staleOpportunityNudges.ts` | Create / Optional | 7D |
| `convex/sideDeals/logPayment.ts` | Modify | 7D |
| `convex/sideDeals/markLost.ts` | Modify | 7D |
| `convex/opportunities/detailQuery.ts` | Modify | 7D |
| `convex/opportunities/listQueries.ts` | Modify | 7D |
| `app/workspace/closer/_components/reminders-section.tsx` | Modify | 7E |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Modify / Guard | 7E |
| `app/workspace/opportunities/[opportunityId]/_components/delete-opportunity-dialog.tsx` | Create | 7E |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-detail-client.tsx` | Modify | 7E |
| `app/workspace/opportunities/_components/opportunities-table.tsx` | Modify | 7E |
