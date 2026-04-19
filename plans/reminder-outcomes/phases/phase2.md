# Phase 2 — Reminder Detail Query

**Goal:** Ship a single RSC-preloadable Convex query (`api.closer.reminderDetail.getReminderDetail`) that returns everything the reminder detail page needs in one round trip — the follow-up record, its parent opportunity, the lead, the latest meeting (for history context + payment linkage), prior payment attempts on the opportunity, and tenant payment links. After this phase, the backend is ready to power the Phase 4 page; no UI exists yet.

**Prerequisite:** Phase 1 deployed (schema updated, `Doc<"followUps">` type now includes `completionOutcome`). The query does not write the field but the return shape passes through the full `Doc<"followUps">`, so the generated types must reflect the new union.

**Runs in PARALLEL with:** Phase 3 (outcome mutations). Phase 2 and Phase 3 touch entirely different Convex files (`reminderDetail.ts` vs. `reminderOutcomes.ts`) with zero shared imports beyond `requireTenantUser.ts`. Both can run the moment Phase 1's generated types are up.

**Skills to invoke:**
- `convex-performance-audit` — The query fans out to several tables (followUp → opportunity → lead → latestMeeting → payments → paymentLinks). Audit index usage and bounded `.take()` calls so we don't regress Convex reads when the page opens. The skill's rules map 1:1 to the patterns used in `convex/closer/meetingDetail.ts` — use that file as the performance reference point.

**Acceptance Criteria:**
1. `api.closer.reminderDetail.getReminderDetail` exists and accepts `{ followUpId: Id<"followUps"> }`.
2. Called with a valid `followUpId` owned by the authenticated closer, the query returns a single object with keys `followUp`, `opportunity`, `lead`, `latestMeeting`, `payments`, `paymentLinks`.
3. Called with a `followUpId` belonging to another tenant, the query returns `null` (not throw).
4. Called with a `followUpId` owned by another closer in the same tenant, the query returns `null`.
5. Called with a `followUpId` whose `type !== "manual_reminder"` (e.g., `scheduling_link`), the query returns `null`.
6. Called with a non-existent `followUpId`, the query returns `null` (graceful).
7. Called by an unauthenticated caller, the query throws (via `requireTenantUser`).
8. The query uses `withIndex(...)` — never `.filter()` — for `paymentRecords` and `paymentLinks` lookups.
9. The `payments` array is bounded to `.take(10)` and ordered by most recent first.
10. The query successfully preloads via `preloadQuery(api.closer.reminderDetail.getReminderDetail, {...}, { token })` from a Next.js RSC (smoke-tested via a scratch page or a unit verification in Phase 4).
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (file + args + auth)  ──────── 2B (joins + return shape)
```

**Optimal execution:**
1. Start **2A** — create the file, wire `requireTenantUser`, validate args, return `null` on any ownership mismatch. This is the smallest possible "query compiles" step.
2. Once the auth skeleton is green, do **2B** — add the parallel `Promise.all` joins, the `.withIndex` lookups for payments + paymentLinks, assemble the final object. One subphase because the joins share the same file; splitting further would churn the file twice for minimal parallel gain.

**Estimated time:** 0.5 day (≈2–3 hours). Tight scope, well-known pattern (mirrors `meetingDetail.ts`).

---

## Subphases

### 2A — Query skeleton, args, and ownership checks

**Type:** Backend
**Parallelizable:** No (within Phase 2, blocks 2B). Parallelizable with all of Phase 3.

**What:** Create `convex/closer/reminderDetail.ts` with a single `query` export (`getReminderDetail`) that takes `{ followUpId }`, runs the auth + tenant + ownership + type guards, and returns `null` for every failure mode. No joins yet.

**Why:** Isolating the auth boilerplate from the join logic lets us land the guard shape once and reason about it in a single sitting. Every follow-up method of this flavour (meeting detail, reminder detail, future admin detail) has identical auth plumbing; if we get it wrong here, it is caught quickly because there is nothing else in the file competing for attention.

**Where:**
- `convex/closer/reminderDetail.ts` (new)

**How:**

**Step 1: Create the file with the required imports. Mirror `convex/closer/meetingDetail.ts` for consistency.**

```typescript
// Path: convex/closer/reminderDetail.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
```

**Step 2: Define `getReminderDetail` with validated args and the full guard chain. Return `null` — not throw — for every "you cannot see this" case so the RSC shell can render an empty state instead of a 500.**

```typescript
// Path: convex/closer/reminderDetail.ts

export const getReminderDetail = query({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    // AUTH: must be a closer. Tenant admins and masters explicitly
    // skipped in MVP (see design doc §12.2, §13.3). If a future admin
    // view wants this data, it will re-authorize here, not reuse this
    // handler's result.
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    // Load the follow-up. Null-check before touching any sibling field.
    const followUp = await ctx.db.get(followUpId);
    if (!followUp) return null;

    // TENANT ISOLATION — never trust the arg. If the id crossed tenants
    // (e.g., crafted URL), act as if the record doesn't exist.
    if (followUp.tenantId !== tenantId) return null;

    // OWNERSHIP — only the closer the reminder is assigned to sees it.
    // Design doc §13.3: "Own only" for closers, no admin view in MVP.
    if (followUp.closerId !== userId) return null;

    // TYPE GUARD — the reminder detail page is for manual_reminder only.
    // Scheduling-link follow-ups live inside the meeting detail page.
    if (followUp.type !== "manual_reminder") return null;

    // Defer joins to 2B. For now just return the envelope so we can
    // smoke-test the auth/ownership chain in isolation.
    return {
      followUp,
      opportunity: null as never, // placeholder — filled in 2B
      lead: null as never,
      latestMeeting: null as never,
      payments: [] as never[],
      paymentLinks: [] as never[],
    };
  },
});
```

> **Runtime decision — return `null` vs. throw:** We mirror `getMeetingDetail`'s convention. Throwing forces the RSC to render an error boundary; returning `null` lets the page render a calm empty state (`<Empty>` with "Reminder Not Found"). Both are safe from an access-control perspective — the bad caller learns nothing beyond "we won't show it."

**Step 3: Smoke-compile the file. `pnpm tsc --noEmit` must pass. This confirms the generated API mapping picks up the new export.**

```bash
pnpm tsc --noEmit
```

**Step 4: (Optional) Briefly call the query from a scratch RSC to confirm it responds. This is not required to hand off to 2B — it's a sanity check.**

```typescript
// Path: (scratch, do not commit)
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

const preloaded = await preloadQuery(
  api.closer.reminderDetail.getReminderDetail,
  { followUpId: SOME_ID as Id<"followUps"> },
  { token: ACCESS_TOKEN },
);
// Expect: { followUp, opportunity: null, lead: null, ... } or `null`
```

**Key implementation notes:**
- **Never accept `tenantId` or `userId` in args.** Always derive from `requireTenantUser(ctx, roles)`. This is the #1 multi-tenant leak pattern and is enforced throughout `convex/closer/**`.
- **Return `null` on ownership mismatch, not an empty object.** The client code uses `detail === null` to branch to the empty state. An empty-ish object would render the page shell with placeholders, leaking UI to an unauthorized caller.
- **Do not log PII.** Any `console.log` here should include `followUpId` + `tenantId` but never the lead's phone or name. (Phase 2B adds a structured log line matching the `[Closer:Reminder]` tag style used elsewhere.)
- **`followUp.type` guard is not redundant.** A closer could hypothetically receive a `scheduling_link` follow-up id (wrong page URL). The type guard stops the page from half-rendering with the wrong assumptions and avoids a downstream crash in the contact card (which expects `reminderScheduledAt`/`contactMethod` to be populated).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderDetail.ts` | Create | Skeleton query with auth + ownership + type guards. Placeholder return shape. |

---

### 2B — Joins, indexed lookups, and the real return shape

**Type:** Backend
**Parallelizable:** No (blocked by 2A inside the file).

**What:** Replace the placeholder return with the real fan-out: parallel `Promise.all` for `opportunity` + `lead`, a direct `ctx.db.get` for `latestMeeting` off the denormalized `opportunity.latestMeetingId`, indexed `.take(10)` of `paymentRecords` by opportunity, and an indexed `.take(20)` of `paymentLinks` by tenant. Add the structured log line and the final typed return.

**Why:** A single round trip to Convex is the performance goal. The RSC preload path calls this query once and hands a serialisable snapshot to the client. Splitting the joins into sibling queries would introduce waterfalls on navigation and duplicate auth work. The design doc §5.1 explicitly chose this pattern, mirroring `getMeetingDetail`.

**Where:**
- `convex/closer/reminderDetail.ts` (modify — fill in the body established in 2A)

**How:**

**Step 1: Replace the placeholder block in the 2A file with the real join chain. Keep the guard chain from 2A unchanged.**

```typescript
// Path: convex/closer/reminderDetail.ts

export const getReminderDetail = query({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    const followUp = await ctx.db.get(followUpId);
    if (!followUp) return null;
    if (followUp.tenantId !== tenantId) return null;
    if (followUp.closerId !== userId) return null;
    if (followUp.type !== "manual_reminder") return null;

    // Parallel fan-out — `opportunityId` and `leadId` on the follow-up
    // are both indexed primary keys, so these are O(1) each and we run
    // them concurrently.
    const [opportunity, lead] = await Promise.all([
      ctx.db.get(followUp.opportunityId),
      ctx.db.get(followUp.leadId),
    ]);

    // Post-fetch tenant checks — defence in depth. If these ever fire
    // it means a cross-tenant foreign key slipped in somehow; returning
    // null is the fail-safe.
    if (!opportunity || opportunity.tenantId !== tenantId) return null;
    if (!lead || lead.tenantId !== tenantId) return null;

    // Latest meeting comes from the denormalized ref on opportunities
    // (see `convex/lib/opportunityMeetingRefs.ts`). If the opportunity
    // never had a meeting, this is simply null — fine for display.
    const latestMeeting = opportunity.latestMeetingId
      ? await ctx.db.get(opportunity.latestMeetingId)
      : null;

    // Prior payments on this opportunity — ordered newest first, bounded
    // to 10. In practice an opportunity has 0-2 payments; 10 is an
    // extremely safe upper bound and prevents an unbounded .collect().
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      )
      .order("desc")
      .take(10);

    // Tenant payment links — same panel the meeting detail page uses.
    const paymentLinks = await ctx.db
      .query("paymentLinks")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(20);

    // Structured log — same tag format as the rest of convex/closer/**.
    // Do NOT include PII (lead name, phone, email).
    console.log("[Closer:Reminder] getReminderDetail", {
      followUpId,
      opportunityStatus: opportunity.status,
      hasLatestMeeting: Boolean(latestMeeting),
      paymentCount: payments.length,
      paymentLinkCount: paymentLinks.length,
    });

    return {
      followUp,
      opportunity,
      lead,
      latestMeeting,
      payments,
      paymentLinks,
    };
  },
});
```

**Step 2: Verify the indexes exist. `paymentRecords.by_opportunityId` and `paymentLinks.by_tenantId` must both be defined in `convex/schema.ts` (they are, as of the current schema — verify via `grep -n` or a quick read). If either is missing, back out to schema — but we do not expect this in Phase 2 because the design doc §10.2 confirms both indexes exist.**

**Step 3: Typecheck the repo.**

```bash
pnpm tsc --noEmit
```

**Step 4: Hand-test the return shape against a real follow-up via the Convex dashboard function runner — pick any `manual_reminder` follow-up, run the query, and confirm the return object matches §5.3 of the design doc.**

```
Dashboard → Functions → closer/reminderDetail:getReminderDetail
Args: { "followUpId": "<paste real id>" }
Expect: { followUp: {...}, opportunity: {...}, lead: {...},
          latestMeeting: {...} | null, payments: [...], paymentLinks: [...] }
```

**Key implementation notes:**
- **`Promise.all` on the independent reads.** `opportunity` and `lead` do not depend on each other — parallel fetches shave off one round trip's worth of latency. `latestMeeting` must wait until `opportunity` resolves because it reads `opportunity.latestMeetingId`.
- **Post-fetch tenant check is belt-and-braces.** Follow-ups already cross-reference the same tenant as their opportunity by construction, but if a historical pipeline bug ever broke that invariant we want to fail closed. Returning `null` (not throwing) keeps the UX consistent.
- **Do not fetch ALL payments.** `paymentRecords.by_opportunityId` handles the scope. `.take(10)` is our upper bound. If we ever support >10 payments per opportunity, the history panel (Phase 4E) is where the pagination story would live.
- **`paymentLinks` is tenant-wide, not opportunity-scoped.** These are the configured stripe/teya/etc. links. 20 is plenty — we currently support ≤5 in production.
- **No `.filter()` anywhere.** Both list queries use `withIndex(...)`. This is the convex-performance-audit skill's hard rule.
- **Return shape is stable.** The client code in Phase 4 will destructure these exact keys. Renaming any one of them later means a cross-file rename. Lock it in now.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/reminderDetail.ts` | Modify | Replace 2A placeholder with full join + indexed lookups + structured log. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/reminderDetail.ts` | Create | 2A |
| `convex/closer/reminderDetail.ts` | Modify | 2B |
