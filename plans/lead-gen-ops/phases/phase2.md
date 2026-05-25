# Phase 2 — Mobile Capture and Prospect Dedupe

**Goal:** Build the worker-facing mobile capture flow and Convex mutation that upserts tenant-scoped social prospects, appends submissions, prevents duplicate mobile retries, and never creates CRM leads or opportunities. After this phase, active lead generators can repeatedly capture Instagram/Meta Business prospects and review their own activity.

**Prerequisite:** Phase 1 complete: schema deployed, `lead_generator` role works, worker profiles sync from WorkOS lifecycle, and route/nav fallbacks are safe.

**Runs in PARALLEL with:** Phase 3 and Phase 4 after Phase 1. Phase 2A/2B/2C can run while Phase 3 builds aggregate helpers, but final capture wiring to aggregate updates waits for Phase 3A.

**Skills to invoke:**
- `convex` — transactional mutation, indexed dedupe, pagination, auth-derived tenant/user context.
- `convex-performance-audit` — check capture write contention and dashboard invalidation risk after seed data.
- `next-best-practices` — thin RSC pages, client components for form state, route `loading.tsx`, and streaming shell preservation.
- `shadcn` — mobile form controls, `ToggleGroup`, `FieldGroup`, `InputGroup`, `Button`, `Badge`, `Skeleton`, and `Empty`.
- `frontend-design` — mobile-first repeated-entry UX with strong feedback and minimal friction.
- `web-design-guidelines` — label, focus, keyboard, target-size, and responsive layout checks.
- `playwright` or `browser:browser` — verify mobile viewport capture and desktop shell integration after implementation.

**Acceptance Criteria:**
1. `lead_generator`, `tenant_master`, and `tenant_admin` can submit from `/workspace/lead-gen/capture`; `closer` cannot submit by calling the mutation directly.
2. Submitting a new Instagram handle inserts one `leadGenProspects` row and one `leadGenSubmissions` row, with tenant and worker identity derived from auth.
3. Submitting the same normalized handle again appends a submission to the same prospect and increments attempt counts without creating a second prospect.
4. Reusing the same `(tenantId, workerId, clientSubmissionKey)` returns the existing submission without changing counters.
5. Capture mutation does not insert, patch, or replace `leads` or `opportunities`.
6. Origin kinds `post` and `reel` are rankable; `follower`, `application`, `story_poll`, `meta_business`, and `other` are not rankable.
7. Worker activity query returns only the authenticated worker's submissions, paginated and newest first.
8. Mobile capture UI shows source, handle/profile, origin, submit feedback, today's count, duplicate status, and last submitted prospect without layout shift.
9. Narrow viewport QA confirms all controls are reachable, text fits, focus states are visible, and repeated submissions can be completed quickly.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Normalization + validators) ─────┬── 2B (Capture mutation + dedupe) ─────┐
                                     │                                       ├── 2D (Capture UI)
Phase 3A (Aggregate helpers) ────────┘                                       │
                                                                             │
2C (Worker activity queries) ────────────────────────────────────────────────┼── 2E (Activity UI)
                                                                             │
2D + 2E complete ────────────────────────────────────────────────────────────┘
                                      │
                                      └── 2F (Mobile QA + performance gate)
```

**Optimal execution:**
1. Start 2A immediately after Phase 1.
2. Build 2B with the raw prospect/submission transaction, then wire aggregate calls after Phase 3A lands.
3. Build 2C independently once schema and workers exist.
4. Start 2D and 2E once their corresponding Convex functions compile.
5. Finish with mobile QA and a search proving no CRM funnel writes exist in `convex/leadGen`.

**Estimated time:** 2-3 days

---

## Subphases

### 2A — Normalization, Origin Parsing, and Submit Contract

**Type:** Backend  
**Parallelizable:** Yes — depends only on Phase 1 validators/schema and does not touch UI or reporting files.

**What:** Add a Lead Gen normalization helper that accepts raw Instagram handles/profile URLs and Meta Business source input, produces a stable dedupe key, validates URL-like origins, and classifies rankable origins.

**Why:** Dedupe correctness depends on one normalization path. Reporting also needs origin rankability to be consistent at write time, not recalculated differently in every query.

**Where:**
- `convex/leadGen/normalization.ts` (new)
- `convex/leadGen/validators.ts` (modify if submit-specific validators are added)

**How:**

**Step 1: Add normalization helpers using the existing shared social normalizer.**

```typescript
// Path: convex/leadGen/normalization.ts
import { normalizeSocialHandle } from "../lib/normalization";
import type { Doc } from "../_generated/dataModel";

type Source = Doc<"leadGenSubmissions">["source"];
type OriginKind = Doc<"leadGenSubmissions">["originKind"];

export type NormalizedLeadGenProspectInput = {
  normalizedHandle: string;
  profileUrl: string;
  dedupeKey: string;
};

export function normalizeLeadGenProspectInput(args: {
  source: Source;
  rawHandleOrProfileUrl: string;
}): NormalizedLeadGenProspectInput {
  const normalizedHandle = normalizeSocialHandle(
    args.rawHandleOrProfileUrl,
    "instagram",
  );

  if (!normalizedHandle) {
    throw new Error("Enter a valid Instagram handle or profile URL");
  }

  return {
    normalizedHandle,
    profileUrl: `https://instagram.com/${normalizedHandle}`,
    dedupeKey: `instagram:${normalizedHandle}`,
  };
}

export function isRankableLeadGenOrigin(originKind: OriginKind) {
  return originKind === "post" || originKind === "reel";
}
```

**Step 2: Add safe origin value parsing.**

```typescript
// Path: convex/leadGen/normalization.ts
export type NormalizedLeadGenOrigin = {
  originValue?: string;
  originKey?: string;
};

export function normalizeLeadGenOrigin(args: {
  originKind: OriginKind;
  originUrlOrLabel?: string;
}): NormalizedLeadGenOrigin {
  const value = args.originUrlOrLabel?.trim();
  if (!value) return {};

  if (args.originKind === "post" || args.originKind === "reel") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported URL protocol");
      }
      url.hash = "";
      return {
        originValue: url.toString(),
        originKey: url.toString().toLowerCase(),
      };
    } catch {
      throw new Error("Enter a valid post or reel URL");
    }
  }

  const normalizedLabel = value.toLowerCase().replace(/\s+/g, " ");
  return {
    originValue: value,
    originKey: `${args.originKind}:${normalizedLabel}`,
  };
}
```

**Step 3: Keep submit validators small and explicit.**

```typescript
// Path: convex/leadGen/validators.ts
export const leadGenSubmitArgsValidator = {
  source: leadGenSourceValidator,
  rawHandleOrProfileUrl: v.string(),
  originKind: leadGenOriginKindValidator,
  originUrlOrLabel: v.optional(v.string()),
  clientSubmissionKey: v.optional(v.string()),
};
```

**Key implementation notes:**
- Meta Business is a source, not a separate prospect platform in MVP. Normalize to Instagram handle when possible.
- Reject URL-looking profile inputs that cannot be parsed by `normalizeSocialHandle()`; do not store ambiguous URL strings as handles.
- Store raw submitted handle on the prospect for audit display, but dedupe only by normalized key.
- Keep origin URL validation server-side even if the client validates first.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/normalization.ts` | Create | Prospect and origin normalization |
| `convex/leadGen/validators.ts` | Modify | Submit argument validator object |

---

### 2B — Capture Mutation, Idempotency, and Prospect Dedupe

**Type:** Backend  
**Parallelizable:** Yes — raw capture can start after 2A; aggregate calls wait for Phase 3A helper exports.

**What:** Implement `leadGen.capture.submit` as a transactional Convex mutation that resolves the worker from auth, handles mobile retry idempotency, upserts the prospect by `(tenantId, dedupeKey)`, appends a submission, updates prospect counters, and calls aggregate helpers.

**Why:** Capture is the high-volume write path. It must be authoritative, tenant-isolated, idempotent for retries, and separate from CRM qualification.

**Where:**
- `convex/leadGen/capture.ts` (new)
- `convex/leadGen/aggregates.ts` (read Phase 3 helper contract)

**How:**

**Step 1: Create the mutation and resolve the active worker.**

```typescript
// Path: convex/leadGen/capture.ts
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  leadGenSubmitArgsValidator,
} from "./validators";
import {
  isRankableLeadGenOrigin,
  normalizeLeadGenOrigin,
  normalizeLeadGenProspectInput,
} from "./normalization";

export const submit = mutation({
  args: leadGenSubmitArgsValidator,
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "lead_generator",
      "tenant_master",
      "tenant_admin",
    ]);

    const worker = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) =>
        q.eq("tenantId", tenantId).eq("userId", userId),
      )
      .unique();

    if (!worker || !worker.isActive) {
      throw new Error("Lead Gen Ops access is not active for this user");
    }

    // Remaining steps below.
  },
});
```

**Step 2: Add idempotency guard before any write.**

```typescript
// Path: convex/leadGen/capture.ts
if (args.clientSubmissionKey) {
  const existingSubmission = await ctx.db
    .query("leadGenSubmissions")
    .withIndex("by_tenantId_and_workerId_and_clientSubmissionKey", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("workerId", worker._id)
        .eq("clientSubmissionKey", args.clientSubmissionKey),
    )
    .unique();

  if (existingSubmission) {
    return {
      submissionId: existingSubmission._id,
      prospectId: existingSubmission.prospectId,
      duplicateRetry: true,
      duplicateProspect: false,
    };
  }
}
```

**Step 3: Upsert the prospect by tenant-scoped dedupe key.**

```typescript
// Path: convex/leadGen/capture.ts
const now = Date.now();
const normalized = normalizeLeadGenProspectInput(args);
const origin = normalizeLeadGenOrigin({
  originKind: args.originKind,
  originUrlOrLabel: args.originUrlOrLabel,
});

let prospect = await ctx.db
  .query("leadGenProspects")
  .withIndex("by_tenantId_and_dedupeKey", (q) =>
    q.eq("tenantId", tenantId).eq("dedupeKey", normalized.dedupeKey),
  )
  .unique();

if (!prospect) {
  const prospectId = await ctx.db.insert("leadGenProspects", {
    tenantId,
    firstSource: args.source,
    latestSource: args.source,
    dedupeKey: normalized.dedupeKey,
    normalizedHandle: normalized.normalizedHandle,
    rawHandle: args.rawHandleOrProfileUrl.trim(),
    profileUrl: normalized.profileUrl,
    firstCapturedByWorkerId: worker._id,
    firstCapturedAt: now,
    lastSubmittedByWorkerId: worker._id,
    lastSubmittedAt: now,
    latestOriginKind: args.originKind,
    latestOriginValue: origin.originValue,
    contactAttemptCount: 0,
    distinctWorkerCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  prospect = await ctx.db.get(prospectId);
  if (!prospect) throw new Error("Prospect insert failed");
}
```

**Step 4: Compute duplicate and distinct-worker state before inserting.**

```typescript
// Path: convex/leadGen/capture.ts
const priorWorkerSubmission = await ctx.db
  .query("leadGenSubmissions")
  .withIndex("by_tenantId_and_prospectId_and_workerId", (q) =>
    q
      .eq("tenantId", tenantId)
      .eq("prospectId", prospect._id)
      .eq("workerId", worker._id),
  )
  .take(1);

const duplicateProspect = prospect.contactAttemptCount > 0;
const isDistinctWorker = priorWorkerSubmission.length === 0;
const originRankable = isRankableLeadGenOrigin(args.originKind);
```

**Step 5: Insert submission and patch prospect counters.**

```typescript
// Path: convex/leadGen/capture.ts
const submissionId = await ctx.db.insert("leadGenSubmissions", {
  tenantId,
  prospectId: prospect._id,
  workerId: worker._id,
  userId,
  teamId: worker.teamId,
  source: args.source,
  originKind: args.originKind,
  originValue: origin.originValue,
  originRankable,
  clientSubmissionKey: args.clientSubmissionKey,
  submittedAt: now,
  createdAt: now,
});

await ctx.db.patch(prospect._id, {
  lastSubmittedByWorkerId: worker._id,
  lastSubmittedAt: now,
  latestOriginKind: args.originKind,
  latestOriginValue: origin.originValue,
  latestSource: args.source,
  contactAttemptCount: prospect.contactAttemptCount + 1,
  distinctWorkerCount:
    prospect.distinctWorkerCount + (isDistinctWorker ? 1 : 0),
  updatedAt: now,
});
```

**Step 6: Wire aggregate helpers after Phase 3A lands.**

```typescript
// Path: convex/leadGen/capture.ts
import {
  updateLeadGenDailyStats,
  updateLeadGenOriginStats,
} from "./aggregates";

await updateLeadGenDailyStats(ctx, {
  tenantId,
  worker,
  source: args.source,
  submittedAt: now,
  duplicateProspectSubmission: duplicateProspect,
  prospectId: prospect._id,
});

if (originRankable && origin.originKey && origin.originValue) {
  await updateLeadGenOriginStats(ctx, {
    tenantId,
    source: args.source,
    originKind: args.originKind,
    originKey: origin.originKey,
    originValue: origin.originValue,
    prospectId: prospect._id,
    submittedAt: now,
  });
}

return {
  submissionId,
  prospectId: prospect._id,
  duplicateRetry: false,
  duplicateProspect,
};
```

**Key implementation notes:**
- Keep this as a mutation, not an action; it only reads/writes Convex data and needs transactional dedupe.
- Do not accept `tenantId`, `userId`, `workerId`, or `submittedAt` from the client.
- Race behavior: Convex OCC should retry conflicting same-prospect inserts. If duplicate prospect rows appear anyway, Phase 5 reconciliation must detect and repair.
- Keep the number of reads/writes bounded. Do not scan raw submissions for counts beyond the specific prospect/worker checks.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/capture.ts` | Create | Capture mutation with idempotency and dedupe |
| `convex/leadGen/aggregates.ts` | Read / Import | Phase 3A helper dependency |

---

### 2C — Worker Activity Queries and Today Summary

**Type:** Backend  
**Parallelizable:** Yes — depends on Phase 1 schema and workers, independent from capture UI.

**What:** Add worker-scoped queries for recent submissions and lightweight current-day feedback used by the mobile page.

**Why:** Workers need immediate confirmation and self-accountability without access to admin reporting or other workers' raw activity.

**Where:**
- `convex/leadGen/activity.ts` (new)

**How:**

**Step 1: Add a shared worker resolver for query contexts.**

```typescript
// Path: convex/leadGen/activity.ts
import { paginationOptsValidator } from "convex/server";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

async function requireActiveLeadGenWorker(ctx: QueryCtx) {
  const { tenantId, userId } = await requireTenantUser(ctx, [
    "lead_generator",
    "tenant_master",
    "tenant_admin",
  ]);

  const worker = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) =>
      q.eq("tenantId", tenantId).eq("userId", userId),
    )
    .unique();

  if (!worker || !worker.isActive) {
    return null;
  }

  return { tenantId, userId, worker };
}
```

**Step 2: Add paginated recent submissions.**

```typescript
// Path: convex/leadGen/activity.ts
export const listMyRecentSubmissions = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const access = await requireActiveLeadGenWorker(ctx);
    if (!access) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    return await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) =>
        q.eq("tenantId", access.tenantId).eq("workerId", access.worker._id),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
```

**Step 3: Add current-day summary from aggregate rows.**

```typescript
// Path: convex/leadGen/activity.ts
import { v } from "convex/values";

export const getMyDaySummary = query({
  args: { dayKey: v.string() },
  handler: async (ctx, { dayKey }) => {
    const access = await requireActiveLeadGenWorker(ctx);
    if (!access) {
      return { submissions: 0, uniqueProspects: 0, duplicates: 0 };
    }

    const rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
        q
          .eq("tenantId", access.tenantId)
          .eq("workerId", access.worker._id)
          .eq("dayKey", dayKey),
      )
      .take(10);

    return rows.reduce(
      (acc, row) => ({
        submissions: acc.submissions + row.submissions,
        uniqueProspects: acc.uniqueProspects + row.uniqueProspectsSubmitted,
        duplicates: acc.duplicates + row.duplicateProspectSubmissions,
      }),
      { submissions: 0, uniqueProspects: 0, duplicates: 0 },
    );
  },
});
```

**Key implementation notes:**
- Querying `leadGenDailyStats` for today's summary depends on Phase 3A aggregate writes. Until then, the UI can still show last submitted status from the mutation result.
- Keep worker activity own-only. Admin all-worker reporting belongs to Phase 3.
- The type of `ctx` in a shared helper should use the actual generated `QueryCtx` import in implementation; avoid `Parameters<>` if it harms readability.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/activity.ts` | Create | Worker own-activity and day-summary queries |

---

### 2D — Mobile Capture Route and Client UI

**Type:** Frontend  
**Parallelizable:** Yes — depends on 2B mutation; independent from activity page.

**What:** Build `/workspace/lead-gen/capture` as a thin RSC wrapper around a mobile-first client form optimized for repeated submission.

**Why:** Lead generators need a fast, low-friction capture surface. Admin configuration and dense reporting should not be mixed into the worker mobile workflow.

**Where:**
- `app/workspace/lead-gen/capture/page.tsx` (new)
- `app/workspace/lead-gen/capture/loading.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-capture-skeleton.tsx` (new)

**How:**

**Step 1: Add the route wrapper.**

```tsx
// Path: app/workspace/lead-gen/capture/page.tsx
import { requirePermission } from "@/lib/auth";
import { LeadGenCapturePageClient } from "../_components/lead-gen-capture-page-client";

export const unstable_instant = false;

export default async function LeadGenCapturePage() {
  await requirePermission("lead-gen:capture");
  return <LeadGenCapturePageClient />;
}
```

**Step 2: Add route loading state.**

```tsx
// Path: app/workspace/lead-gen/capture/loading.tsx
import { LeadGenCaptureSkeleton } from "../_components/lead-gen-capture-skeleton";

export default function LeadGenCaptureLoading() {
  return <LeadGenCaptureSkeleton />;
}
```

**Step 3: Build client form with RHF and Zod.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx
"use client";

import { useId, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

const captureSchema = z.object({
  source: z.enum(["instagram", "meta_business"]),
  rawHandleOrProfileUrl: z.string().min(1, "Handle or profile URL is required"),
  originKind: z.enum([
    "post",
    "reel",
    "story_poll",
    "follower",
    "application",
    "meta_business",
    "other",
  ]),
  originUrlOrLabel: z.string().optional(),
});

type CaptureValues = z.infer<typeof captureSchema>;
```

**Step 4: Generate idempotency keys per submit.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx
function makeClientSubmissionKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function LeadGenCapturePageClient() {
  const submit = useMutation(api.leadGen.capture.submit);
  const [lastResult, setLastResult] = useState<{
    duplicateProspect: boolean;
    submittedAt: number;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm({
    resolver: standardSchemaResolver(captureSchema),
    defaultValues: {
      source: "instagram",
      rawHandleOrProfileUrl: "",
      originKind: "post",
      originUrlOrLabel: "",
    },
  });

  const onSubmit = async (values: CaptureValues) => {
    setIsSubmitting(true);
    try {
      const result = await submit({
        ...values,
        originUrlOrLabel: values.originUrlOrLabel?.trim() || undefined,
        clientSubmissionKey: makeClientSubmissionKey(),
      });
      setLastResult({
        duplicateProspect: result.duplicateProspect,
        submittedAt: Date.now(),
      });
      form.reset({
        source: values.source,
        originKind: values.originKind,
        rawHandleOrProfileUrl: "",
        originUrlOrLabel: values.originUrlOrLabel,
      });
      toast.success("Prospect captured");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Capture failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <CaptureHeader lastResult={lastResult} />
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup>
            {/* Fields shown in Step 5 */}
          </FieldGroup>
        </form>
      </Form>
    </div>
  );
}
```

**Step 5: Use mobile-friendly controls.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx
<FormField
  control={form.control}
  name="source"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Source</FormLabel>
      <FormControl>
        <ToggleGroup
          type="single"
          value={field.value}
          onValueChange={(value) => {
            if (value) field.onChange(value);
          }}
          className="grid grid-cols-2"
        >
          <ToggleGroupItem value="instagram">Instagram</ToggleGroupItem>
          <ToggleGroupItem value="meta_business">Meta Business</ToggleGroupItem>
        </ToggleGroup>
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>

<FormField
  control={form.control}
  name="rawHandleOrProfileUrl"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Handle or profile URL</FormLabel>
      <FormControl>
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
          placeholder="@prospect or instagram.com/prospect"
          disabled={isSubmitting}
          {...field}
        />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>

<Button className="w-full" type="submit" disabled={isSubmitting}>
  {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
  {isSubmitting ? "Capturing..." : "Capture Prospect"}
</Button>
```

**Key implementation notes:**
- Avoid putting the capture form in a decorative card if the existing workspace content uses flat operational layouts; keep it centered and focused.
- Use `ToggleGroup` for the two-source segmented control, not two manually styled buttons.
- Keep text compact and utilitarian. Do not add instructional marketing copy inside the app.
- Preserve source/origin defaults after submit so repeated entry is fast; clear only the handle field.
- Use a stable min-height skeleton matching the loaded layout to prevent CLS.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/lead-gen/capture/page.tsx` | Create | RSC permission wrapper |
| `app/workspace/lead-gen/capture/loading.tsx` | Create | Route loading state |
| `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx` | Create | Mobile capture form |
| `app/workspace/lead-gen/_components/lead-gen-capture-skeleton.tsx` | Create | Capture skeleton |

---

### 2E — My Activity Route and Recent Submission List

**Type:** Frontend  
**Parallelizable:** Yes — depends on 2C query; independent from capture form polish.

**What:** Build `/workspace/lead-gen/my-activity` for workers/admins to inspect their own recent submissions, duplicate signals, and current-day summary.

**Why:** Workers need accountability and confirmation without exposing all-worker reporting. This also gives admins a low-risk way to test capture as themselves.

**Where:**
- `app/workspace/lead-gen/my-activity/page.tsx` (new)
- `app/workspace/lead-gen/my-activity/loading.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx` (new)
- `app/workspace/lead-gen/_components/lead-gen-activity-skeleton.tsx` (new)

**How:**

**Step 1: Add route wrapper.**

```tsx
// Path: app/workspace/lead-gen/my-activity/page.tsx
import { requirePermission } from "@/lib/auth";
import { LeadGenActivityPageClient } from "../_components/lead-gen-activity-page-client";

export const unstable_instant = false;

export default async function LeadGenMyActivityPage() {
  await requirePermission("lead-gen:view-own");
  return <LeadGenActivityPageClient />;
}
```

**Step 2: Render summary and paginated list.**

```tsx
// Path: app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx
"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function LeadGenActivityPageClient() {
  const recent = usePaginatedQuery(
    api.leadGen.activity.listMyRecentSubmissions,
    {},
    { initialNumItems: 25 },
  );

  if (recent.results.length === 0 && recent.status !== "LoadingMore") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No submissions yet</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>Captured prospects will appear here.</EmptyContent>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold tracking-normal">My Activity</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Submitted</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Origin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recent.results.map((submission) => (
            <TableRow key={submission._id}>
              <TableCell>{new Date(submission.submittedAt).toLocaleString()}</TableCell>
              <TableCell>
                <Badge variant="secondary">{submission.source}</Badge>
              </TableCell>
              <TableCell>{submission.originValue ?? submission.originKind}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {recent.status === "CanLoadMore" ? (
        <Button variant="outline" onClick={() => recent.loadMore(25)}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
```

**Key implementation notes:**
- Use `usePaginatedQuery` for recent rows; do not `.take(500)` into a reactive list on the client.
- Render raw user-entered strings as text only; never inject origin/profile values as HTML.
- Use `Empty` for no-data state and `Skeleton` for loading state, matching shadcn guidance.
- If prospect display details are needed, add a bounded join query in Convex rather than doing client-side N+1 reads.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/lead-gen/my-activity/page.tsx` | Create | RSC permission wrapper |
| `app/workspace/lead-gen/my-activity/loading.tsx` | Create | Route loading state |
| `app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx` | Create | Worker activity list |
| `app/workspace/lead-gen/_components/lead-gen-activity-skeleton.tsx` | Create | Activity skeleton |

---

### 2F — Mobile QA, No-Funnel-Writes Gate, and Capture Performance Check

**Type:** QA / Performance  
**Parallelizable:** No — runs after 2B through 2E are complete and Phase 3A aggregate helper is wired.

**What:** Verify mobile capture behavior, authorization, idempotency, dedupe, no CRM funnel writes, and bounded Convex read/write patterns.

**Why:** Capture is high-frequency and worker-facing. Small UX or idempotency bugs will be repeated many times per day.

**Where:**
- `convex/leadGen/capture.ts` (verify)
- `app/workspace/lead-gen/capture/*` (verify)
- `plans/lead-gen-ops/phases/phase0-qa-matrix.md` (read)

**How:**

**Step 1: Run automated checks.**

```bash
# Path: terminal
pnpm tsc --noEmit
pnpm lint
rg "ctx\\.db\\.(insert|patch|replace)\\(\\\"(leads|opportunities)\\\"" convex/leadGen
```

The `rg` command must return no matches.

**Step 2: Run mobile viewport QA.**

```bash
# Path: terminal
pnpm dev
```

Open `/workspace/lead-gen/capture` at a narrow viewport and verify:

- Source segmented control fits without wrapping awkwardly.
- Handle input remains focused after validation errors.
- Submit button has a stable height across idle/loading states.
- Success feedback identifies duplicate vs new prospect.
- Repeated submissions can be made without navigating away.

**Step 3: Trace the capture transaction.**

```markdown
<!-- Path: implementation review notes -->

Capture mutation expected read/write set:

- Read `users` through `requireTenantUser()`.
- Read `leadGenWorkers` by `(tenantId, userId)`.
- Optional read `leadGenSubmissions` by `(tenantId, workerId, clientSubmissionKey)`.
- Read/insert `leadGenProspects` by `(tenantId, dedupeKey)`.
- Read `leadGenSubmissions` by `(tenantId, prospectId, workerId)`.
- Insert `leadGenSubmissions`.
- Patch `leadGenProspects`.
- Upsert bounded daily/origin aggregate rows.
```

**Key implementation notes:**
- If Convex insights show OCC conflicts on same prospect during QA, inspect whether hot fields on `leadGenProspects` need a lighter aggregate strategy before production rollout.
- Do not add offline-first background sync in MVP; `clientSubmissionKey` handles retry idempotency only.
- Keep mobile capture accessible with labels, focus states, and touch targets. Do not rely on placeholder-only instructions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| No production code | Verify | Mobile, auth, and performance gate |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leadGen/normalization.ts` | Create | 2A |
| `convex/leadGen/validators.ts` | Modify | 2A |
| `convex/leadGen/capture.ts` | Create | 2B |
| `convex/leadGen/activity.ts` | Create | 2C |
| `app/workspace/lead-gen/capture/page.tsx` | Create | 2D |
| `app/workspace/lead-gen/capture/loading.tsx` | Create | 2D |
| `app/workspace/lead-gen/_components/lead-gen-capture-page-client.tsx` | Create | 2D |
| `app/workspace/lead-gen/_components/lead-gen-capture-skeleton.tsx` | Create | 2D |
| `app/workspace/lead-gen/my-activity/page.tsx` | Create | 2E |
| `app/workspace/lead-gen/my-activity/loading.tsx` | Create | 2E |
| `app/workspace/lead-gen/_components/lead-gen-activity-page-client.tsx` | Create | 2E |
| `app/workspace/lead-gen/_components/lead-gen-activity-skeleton.tsx` | Create | 2E |
