# Phase 5 — Corrections, QA, and Release Gates

**Goal:** Add admin correction/void flows, aggregate delta safety, reconciliation repair, and final release gates for Lead Gen Ops. After this phase, the feature can ship with auditable corrections, verified Slack/Calendly regressions, export hardening, route safety, and mobile/desktop QA.

**Prerequisite:** Phases 1-4 complete. Capture, aggregates, reporting, exports, and audit matching exist and have seed data for verification.

**Runs in PARALLEL with:** Nothing at the phase level — this is the stabilization and release phase. Some internal QA streams can run in parallel after correction functions compile.

**Skills to invoke:**
- `convex` — correction mutations, aggregate deltas, bounded reconciliation, and internal repair scheduling.
- `convex-migration-helper` — required if any correction work changes existing required fields or backfills production data.
- `convex-performance-audit` — verify correction/reconciliation functions stay within transaction limits.
- `next-best-practices` — route error/loading states and client boundary review.
- `shadcn` — correction dialogs, destructive confirmation, tables, alerts, and skeletons.
- `frontend-design` — correction UX should be precise, calm, and audit-oriented.
- `web-design-guidelines` — accessibility review for destructive dialogs, table actions, and mobile capture.
- `playwright` or `browser:browser` — mobile capture and desktop admin visual/browser QA.

**Acceptance Criteria:**
1. Admins can void a submission with a required reason; workers and closers cannot void by direct mutation calls.
2. Voiding a submission sets `voidedAt`, `voidedByUserId`, and `voidReason` without deleting the raw submission.
3. Every correction inserts a `leadGenCorrectionEvents` row with before/after snapshots and correcting user ID.
4. Corrections that affect reportable fields apply daily/origin aggregate reverse deltas in the same transaction or mark the bounded range for reconciliation.
5. Reconciliation can audit and repair a bounded date range without `.collect()` or unbounded deletes.
6. Admin correction UI clearly distinguishes voiding from deletion and requires a reason before enabling the destructive action.
7. CSV exports still formula-harden corrected/voided user-entered values.
8. Full QA covers role routing, capture, dedupe, reporting, exports, Slack qualification, Calendly scheduling, and direct Convex authorization failures.
9. Browser QA passes for mobile capture and desktop admin reporting with no overlapping text or unstable layout.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Correction mutations + deltas) ─────┬── 5B (Correction UI) ─────────────┐
                                        ├── 5C (Reconciliation repair) ─────┤
                                        └── 5D (Security/export hardening) ──┤
                                                                             ├── 5E (Full QA matrix)
5E complete ────────────────────────────────────────────────────────────────┘
                                      │
                                      └── 5F (Release gate + rollout notes)
```

**Optimal execution:**
1. Implement 5A first because UI and repair paths depend on correction semantics.
2. Run 5B, 5C, and 5D in parallel after 5A; they touch UI, repair backend, and QA/security checklists separately.
3. Run 5E after all functionality is wired.
4. Finish with 5F and do not deploy until the release checklist is green.

**Estimated time:** 2-3 days

---

## Subphases

### 5A — Correction Mutations and Aggregate Delta Helpers

**Type:** Backend  
**Parallelizable:** No — correction UI and reconciliation depend on this contract.

**What:** Add admin-only correction mutations for voiding submissions and helper functions that reverse aggregate rows consistently.

**Why:** Lead Gen Ops counts can affect worker accountability. Corrections must be auditable and must not leave dashboard totals drifting from raw rows.

**Where:**
- `convex/leadGen/corrections.ts` (new)
- `convex/leadGen/aggregates.ts` (modify)

**How:**

**Step 1: Add aggregate delta helper.**

```typescript
// Path: convex/leadGen/aggregates.ts
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";

export async function applyLeadGenAggregateDelta(
  ctx: MutationCtx,
  args: {
    submission: Doc<"leadGenSubmissions">;
    delta: 1 | -1;
    reason: "voided" | "restored" | "edited";
  },
) {
  const dayKey = timestampToBusinessDateKey(args.submission.submittedAt);
  const statRows = await ctx.db
    .query("leadGenDailyStats")
    .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.submission.tenantId)
        .eq("workerId", args.submission.workerId)
        .eq("dayKey", dayKey),
    )
    .take(10);

  const stat = statRows.find((row) => row.source === args.submission.source);
  if (!stat) {
    throw new Error("Aggregate row not found for correction");
  }

  await ctx.db.patch(stat._id, {
    submissions: Math.max(0, stat.submissions + args.delta),
    updatedAt: Date.now(),
  });

  if (args.submission.originRankable && args.submission.originValue) {
    const originRows = await ctx.db
      .query("leadGenOriginStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q.eq("tenantId", args.submission.tenantId).eq("dayKey", dayKey),
      )
      .take(100);

    const origin = originRows.find(
      (row) => row.originValue === args.submission.originValue,
    );
    if (origin) {
      await ctx.db.patch(origin._id, {
        submissions: Math.max(0, origin.submissions + args.delta),
        updatedAt: Date.now(),
      });
    }
  }
}
```

**Step 2: Add void mutation with durable correction event.**

```typescript
// Path: convex/leadGen/corrections.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { applyLeadGenAggregateDelta } from "./aggregates";

export const voidSubmission = mutation({
  args: {
    submissionId: v.id("leadGenSubmissions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const reason = args.reason.trim();
    if (reason.length < 3) {
      throw new Error("A correction reason is required");
    }

    const submission = await ctx.db.get(args.submissionId);
    if (!submission || submission.tenantId !== tenantId) {
      throw new Error("Submission not found");
    }
    if (submission.voidedAt) return { submissionId: submission._id };

    const now = Date.now();
    const afterSnapshot = {
      ...submission,
      voidedAt: now,
      voidedByUserId: userId,
      voidReason: reason,
    };

    await ctx.db.patch(submission._id, {
      voidedAt: now,
      voidedByUserId: userId,
      voidReason: reason,
    });

    await applyLeadGenAggregateDelta(ctx, {
      submission,
      delta: -1,
      reason: "voided",
    });

    await ctx.db.insert("leadGenCorrectionEvents", {
      tenantId,
      targetType: "submission",
      targetId: submission._id,
      correctionKind: "voided",
      reason,
      beforeSnapshot: JSON.stringify(submission),
      afterSnapshot: JSON.stringify(afterSnapshot),
      correctedByUserId: userId,
      correctedAt: now,
    });

    return { submissionId: submission._id };
  },
});
```

**Step 3: Defer worker self-editing unless product explicitly approves it.**

```typescript
// Path: convex/leadGen/corrections.ts
// MVP decision: workers do not edit saved submissions.
// Immediate client-side correction before submit is allowed by changing form values.
// Saved data changes are admin-only and audited.
```

**Key implementation notes:**
- A void is not a delete. Do not remove raw rows or prospect rows.
- Reverse deltas for unique prospects/duplicates are harder than submission count. If the helper cannot prove the correct reverse delta, mark the range for reconciliation instead of guessing.
- Use `Math.max(0, ...)` defensively, but also log or audit if a counter would go negative.
- Keep snapshots as JSON strings because Convex schemas need stable validators for flexible audit payloads.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/corrections.ts` | Create | Admin correction mutations |
| `convex/leadGen/aggregates.ts` | Modify | Aggregate reverse delta helper |

---

### 5B — Admin Correction UI and Destructive Confirmation

**Type:** Frontend  
**Parallelizable:** Yes — depends on 5A mutation contract; independent from reconciliation repair internals.

**What:** Add admin-only void/correction controls to raw submission tables or prospect detail surfaces, using a destructive confirmation dialog with required reason.

**Why:** Correction UX must prevent accidental destructive actions and make it clear that voiding excludes a row from reports without deleting history.

**Where:**
- `app/workspace/lead-gen/_components/void-submission-dialog.tsx` (new)
- `app/workspace/lead-gen/_components/raw-submissions-table.tsx` (new or modify if created in Phase 3/4)
- `app/workspace/lead-gen/prospects/[prospectId]/page.tsx` (optional modify)

**How:**

**Step 1: Add void dialog with required reason.**

```tsx
// Path: app/workspace/lead-gen/_components/void-submission-dialog.tsx
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

const voidSchema = z.object({
  reason: z.string().min(3, "Reason is required"),
});

export function VoidSubmissionDialog({
  submissionId,
}: {
  submissionId: Id<"leadGenSubmissions">;
}) {
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const voidSubmission = useMutation(api.leadGen.corrections.voidSubmission);
  const form = useForm({
    resolver: standardSchemaResolver(voidSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: z.infer<typeof voidSchema>) => {
    setIsSaving(true);
    try {
      await voidSubmission({ submissionId, reason: values.reason });
      toast.success("Submission voided");
      setOpen(false);
      form.reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Void failed");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">Void</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void submission?</AlertDialogTitle>
          <AlertDialogDescription>
            This excludes the submission from reporting but keeps the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea disabled={isSaving} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AlertDialogFooter className="pt-4">
              <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
              <Button variant="destructive" type="submit" disabled={isSaving}>
                {isSaving ? <Spinner data-icon="inline-start" /> : null}
                Void submission
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Step 2: Surface void state in tables.**

```tsx
// Path: app/workspace/lead-gen/_components/raw-submissions-table.tsx
import { Badge } from "@/components/ui/badge";

function SubmissionStatus({ voidedAt }: { voidedAt?: number }) {
  return voidedAt ? (
    <Badge variant="destructive">Voided</Badge>
  ) : (
    <Badge variant="secondary">Active</Badge>
  );
}
```

**Key implementation notes:**
- Use `AlertDialog` for destructive action; include `AlertDialogTitle`.
- Do not put row actions behind hover-only controls; they must be keyboard reachable.
- Keep "void" language consistent. Avoid "delete" anywhere in the correction UI.
- Use `toast` for mutation feedback and inline `FormMessage` for reason validation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/lead-gen/_components/void-submission-dialog.tsx` | Create | Admin void confirmation |
| `app/workspace/lead-gen/_components/raw-submissions-table.tsx` | Create / Modify | Status and row action |
| `app/workspace/lead-gen/prospects/[prospectId]/page.tsx` | Modify | Optional correction entry point |

---

### 5C — Bounded Reconciliation Repair

**Type:** Backend / Admin Repair  
**Parallelizable:** Yes — depends on 5A semantics; independent from UI.

**What:** Add an admin/internal repair path that rebuilds aggregates for a small date range when direct deltas are not enough.

**Why:** Aggregate drift should be fixable without manual database edits, but rebuilds must stay bounded and safe.

**Where:**
- `convex/leadGen/reconciliation.ts` (modify)

**How:**

**Step 1: Add admin repair mutation with strict bounds.**

```typescript
// Path: convex/leadGen/reconciliation.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const markRangeForReconciliation = mutation({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const maxRangeMs = 14 * 24 * 60 * 60 * 1000;
    if (args.endTimestamp <= args.startTimestamp) {
      throw new Error("Invalid reconciliation range");
    }
    if (args.endTimestamp - args.startTimestamp > maxRangeMs) {
      throw new Error("Reconciliation range is too large");
    }

    await ctx.db.insert("leadGenCorrectionEvents", {
      tenantId,
      targetType: "submission",
      targetId: `range:${args.startTimestamp}:${args.endTimestamp}`,
      correctionKind: "edited",
      reason: args.reason.trim(),
      beforeSnapshot: JSON.stringify({ start: args.startTimestamp }),
      afterSnapshot: JSON.stringify({ end: args.endTimestamp }),
      correctedByUserId: userId,
      correctedAt: Date.now(),
    });

    return { queued: true };
  },
});
```

**Step 2: Add rebuild only after delete/upsert strategy is finalized.**

```typescript
// Path: convex/leadGen/reconciliation.ts
// When implementing full rebuild:
// 1. Delete aggregate rows only for the bounded business-day range.
// 2. Page raw non-voided submissions by `by_tenantId_and_submittedAt`.
// 3. Recompute stat rows through the same aggregate helpers used by capture.
// 4. Schedule continuations with `ctx.scheduler.runAfter(0, ...)` if page limits are hit.
// 5. Insert a correction event with repair summary.
```

**Key implementation notes:**
- A mark-and-audit mutation is safer than a broad rebuild in the first MVP unless drift is observed.
- If full rebuild is implemented, do not use `.collect()` and do not delete rows outside the exact tenant/date range.
- Repair should be admin-only and should leave an audit event.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/reconciliation.ts` | Modify | Bounded reconciliation marker or repair mutation |

---

### 5D — Security, Export, and Route Hardening

**Type:** QA / Security  
**Parallelizable:** Yes — can run while 5B and 5C implementation is reviewed.

**What:** Re-check multi-tenant isolation, role permissions, CSV hardening, input limits, route access, command palette visibility, and no-funnel-write constraints.

**Why:** This phase is the last chance to catch cross-role data exposure and unsafe exports before release.

**Where:**
- `convex/leadGen/**` (verify)
- `lib/auth.ts` (verify)
- `components/command-palette.tsx` (verify)
- `app/workspace/_components/workspace-shell-client.tsx` (verify)
- `lib/csv.ts` (verify)

**How:**

**Step 1: Run static security checks.**

```bash
# Path: terminal
rg "tenantId: v\\.id\\(\"tenants\"\\)" convex/leadGen
rg "args: \\{[^}]*tenantId" convex/leadGen
rg "requireTenantUser" convex/leadGen
rg "ctx\\.db\\.(insert|patch|replace)\\(\\\"(leads|opportunities)\\\"" convex/leadGen
```

Expected:

- New tables have `tenantId`.
- Public functions do not accept client-supplied `tenantId`.
- Public functions call `requireTenantUser()`.
- No Lead Gen capture/report/correction code writes CRM funnel tables.

**Step 2: Run route and command checks.**

```bash
# Path: terminal
rg "lead_generator|lead-gen:capture|lead-gen:view-all|lead-gen:correct" app components lib convex
rg "Create opportunity|/workspace/opportunities/new" components/command-palette.tsx app/workspace/_components/workspace-shell-client.tsx
```

Confirm `Create opportunity` is not visible to `lead_generator`.

**Step 3: Test export hardening with hostile values.**

```typescript
// Path: QA scratch or unit test
const rows = [
  ["label"],
  ["=HYPERLINK(\"https://example.com\")"],
  ["+SUM(1,2)"],
  ["-10+20"],
  ["@cmd"],
  ["normal, comma"],
  ["line\nbreak"],
];
```

**Key implementation notes:**
- If any public Lead Gen function accepts `tenantId`, stop and redesign that function before release.
- Use input length checks for handles, labels, reasons, and team names. Very long strings can hurt UI and exports even if Convex accepts them.
- Confirm `lead_generator` cannot access CRM reports through direct URLs, command palette, or keyboard shortcuts.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| No production code | Verify | Security and route hardening |

---

### 5E — Full QA Matrix and Browser Verification

**Type:** QA / Browser  
**Parallelizable:** No — runs after all feature code and hardening checks.

**What:** Execute the complete QA matrix across roles, capture, reporting, corrections, Slack, Calendly, exports, and browser viewports.

**Why:** The feature crosses multiple systems. Release confidence comes from end-to-end behavior, not just TypeScript.

**Where:**
- `plans/lead-gen-ops/phases/phase0-qa-matrix.md` (read)
- Local app browser at mobile and desktop viewports

**How:**

**Step 1: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
npx convex dev --once
```

**Step 2: Run role QA.**

```markdown
<!-- Path: QA notes -->

- Admin can open `/workspace/lead-gen`, settings, prospects, exports, and correction dialogs.
- Lead generator can open capture and my activity only.
- Closer cannot open capture, admin reporting, corrections, or exports.
- System admin still redirects to `/admin`, not workspace Lead Gen routes.
```

**Step 3: Run data-flow QA.**

```markdown
<!-- Path: QA notes -->

- New capture creates one prospect/submission and no CRM lead/opportunity.
- Duplicate capture reuses prospect and increments duplicate count.
- Same client submission key returns existing submission.
- Admin void updates raw row, correction event, and dashboard totals.
- Summary export and raw export both escape formula-like values.
```

**Step 4: Run Slack/Calendly regression QA.**

```markdown
<!-- Path: QA notes -->

- Slack created opportunity with prior prospect -> accepted audit match.
- Slack duplicate pending with prior prospect -> accepted match reused or created.
- Slack already booked -> no accepted match by default.
- Calendly Slack join with existing match -> match preserved.
- Calendly cold booking with matching prospect -> no Lead Gen lookup or match.
```

**Step 5: Browser QA.**

```markdown
<!-- Path: QA notes -->

- Mobile capture at 390px: no overlapping controls, submit remains visible, keyboard does not hide required action.
- Desktop admin at 1440px: filters/cards/tables align and text fits.
- Tablet admin at 1024px: tables remain usable with overflow if needed.
- Loading skeletons match final dimensions.
- Empty states use `Empty` and do not imply setup failure.
```

**Key implementation notes:**
- Use the Browser plugin or Playwright for screenshots after frontend changes.
- Capture a failure note with exact route, role, viewport, and seed data state.
- Do not mark release-ready if existing Slack or Calendly behavior changed in no-match scenarios.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| No production code | Verify | Full QA matrix and browser checks |

---

### 5F — Release Gate, Rollout, and Backout Notes

**Type:** Release / Operations  
**Parallelizable:** No — final approval step.

**What:** Create final release notes documenting deployment order, production preflight, smoke tests, known limitations, and backout plan.

**Why:** The feature is under heavy development but production has a test tenant. Release steps should be explicit and reversible.

**Where:**
- `plans/lead-gen-ops/phases/release-checklist.md` (new)

**How:**

**Step 1: Create release checklist.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/release-checklist.md -->

# Lead Gen Ops Release Checklist

## Preflight

- [ ] WorkOS role slug `lead-generator` exists in production.
- [ ] Phase 0 migration notes still classify rollout as widen-only.
- [ ] `npx convex dev --once` passes locally.
- [ ] `pnpm tsc --noEmit` passes.
- [ ] `pnpm lint` passes.

## Production Smoke

- [ ] Admin opens `/workspace/lead-gen`.
- [ ] Test lead generator opens `/workspace/lead-gen/capture`.
- [ ] Capture creates Lead Gen rows only.
- [ ] Dashboard totals update.
- [ ] Export hardening smoke passes.
- [ ] Slack qualification regression passes.
- [ ] Calendly cold booking regression passes.

## Backout

- [ ] Disable inviting new lead generators by hiding role option if needed.
- [ ] Keep schema/tables deployed; do not delete Lead Gen rows.
- [ ] Remove or guard Slack/Calendly audit hooks if integration regression appears.
- [ ] Deactivate worker profiles instead of deleting users.
```

**Step 2: Document known MVP limitations.**

```markdown
<!-- Path: plans/lead-gen-ops/phases/release-checklist.md -->

## Known MVP Limitations

- Lead Gen Ops does not create CRM leads or opportunities.
- Audit matches do not count as conversions or compensation.
- Workers cannot edit saved submissions.
- Offline-first capture is not included.
- Cold Calendly bookings never search Lead Gen prospects.
- Payout automation is deferred to a separate compensation design.
```

**Key implementation notes:**
- Backout should prefer hiding UI and disabling hooks over destructive schema/data changes.
- Keep Lead Gen tables after deployment even if UI is disabled; deleting schema fields with data at rest is a migration project.
- Production smoke should use the one test tenant before any real worker rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/release-checklist.md` | Create | Production release and backout notes |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leadGen/corrections.ts` | Create | 5A |
| `convex/leadGen/aggregates.ts` | Modify | 5A |
| `app/workspace/lead-gen/_components/void-submission-dialog.tsx` | Create | 5B |
| `app/workspace/lead-gen/_components/raw-submissions-table.tsx` | Create / Modify | 5B |
| `app/workspace/lead-gen/prospects/[prospectId]/page.tsx` | Modify | 5B |
| `convex/leadGen/reconciliation.ts` | Modify | 5C |
| `plans/lead-gen-ops/phases/release-checklist.md` | Create | 5F |
