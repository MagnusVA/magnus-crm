# Phase 1 — Schema Evolution & Backend Foundation

**Goal:** Widen the `followUps` table to support two follow-up types (scheduling link and manual reminder), add `personalEventTypeUri` to the `users` table, register new permissions, create all new Convex mutations and queries, and deploy the schema. After this phase, the backend is fully operational — every subsequent phase only wires UI or pipeline logic to these functions.

**Prerequisite:** v0.4 fully deployed. Feature G (UTM Tracking) and Feature I (Meeting Detail Enhancements) complete. Read `convex/_generated/ai/guidelines.md` before any Convex work.

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on this phase's schema and functions.

> **Critical path:** This phase is on the critical path (Phase 1 → Phases 2-5).
> Start immediately.

**Skills to invoke:**
- `convex-migration-helper` — Schema changes are additive (`v.optional`), but invoke if a backfill of existing `followUps` records with the new `type` field is desired.
- `convex-performance-audit` — Validate query efficiency of `getActiveReminders` and the new `by_tenantId_and_closerId_and_status` index after deployment.

**Acceptance Criteria:**
1. `npx convex dev` runs without schema errors after deploying the modified `followUps` and `users` tables.
2. Existing `followUps` records (without `type`, `contactMethod`, `reminderScheduledAt`, `completedAt`) remain readable — no runtime errors from missing fields.
3. The `followUps.status` union includes `"completed"` alongside `"pending"`, `"booked"`, and `"expired"`.
4. The `users` table includes `personalEventTypeUri: v.optional(v.string())`.
5. The new index `by_tenantId_and_closerId_and_status` is visible in the Convex dashboard.
6. `api.closer.followUpMutations.createSchedulingLinkFollowUp` is callable and returns `{ schedulingLinkUrl, followUpId }`.
7. `api.closer.followUpMutations.createManualReminderFollowUpPublic` is callable and creates a `followUps` record with `type: "manual_reminder"`.
8. `api.closer.followUpMutations.markReminderComplete` transitions a pending manual reminder to `completed` and sets `completedAt`.
9. `api.closer.followUpQueries.getActiveReminders` returns pending manual reminders enriched with `leadName` and `leadPhone`, sorted by `reminderScheduledAt` ascending.
10. `convex/lib/permissions.ts` includes `"team:assign-event-type"`, `"follow-up:create"`, and `"follow-up:complete"`.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema widening) ─────────────────────────────────────────┐
                                                               ├── 1D (Public mutations — depends on 1A, 1B, 1C)
1B (Permissions) ─────────────────────────────────────────────┤
                                                               │
1C (Follow-up queries) ──────────────────────────────────────┘

1D complete ──→ 1E (Deploy & verify)
```

**Optimal execution:**
1. Start 1A (schema), 1B (permissions), and 1C (query file) in parallel — they touch different files.
2. Once 1A, 1B, and 1C are done → start 1D (public mutations that import schema types and use status transitions).
3. Once 1D is done → start 1E (deploy and verify everything together).

**Estimated time:** 1 day

---

## Subphases

### 1A — Schema Widening (followUps + users)

**Type:** Backend
**Parallelizable:** No — must complete first. All other subphases depend on the generated types from this schema.

**What:** Widen the `followUps` table with `type`, `contactMethod`, `reminderScheduledAt`, `reminderNote`, `completedAt` fields. Add `"completed"` to the `status` union. Add the `by_tenantId_and_closerId_and_status` index. Add `personalEventTypeUri` to the `users` table.

**Why:** Every subsequent mutation and query imports types from `convex/_generated/dataModel`. Without these table definitions, TypeScript compilation fails. All new fields are `v.optional(...)` so existing records are unaffected.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Widen the `followUps` table**

Replace the current `followUps` table definition (lines 265-286 in schema.ts):

```typescript
// Path: convex/schema.ts — BEFORE (followUps table, lines 265-286)
followUps: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  closerId: v.id("users"),
  schedulingLinkUrl: v.optional(v.string()),
  calendlyEventUri: v.optional(v.string()),
  reason: v.union(
    v.literal("closer_initiated"),
    v.literal("cancellation_follow_up"),
    v.literal("no_show_follow_up"),
  ),
  status: v.union(
    v.literal("pending"),
    v.literal("booked"),
    v.literal("expired"),
  ),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"]),
```

Replace with:

```typescript
// Path: convex/schema.ts — AFTER (followUps table)
followUps: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  closerId: v.id("users"),

  // Discriminator: which follow-up path was used.
  // Optional for backward compatibility with pre-Feature-A records.
  type: v.optional(
    v.union(
      v.literal("scheduling_link"),
      v.literal("manual_reminder"),
    ),
  ),

  // --- Scheduling link fields ---
  schedulingLinkUrl: v.optional(v.string()),
  calendlyEventUri: v.optional(v.string()),

  // --- Manual reminder fields ---
  contactMethod: v.optional(
    v.union(v.literal("call"), v.literal("text")),
  ),
  reminderScheduledAt: v.optional(v.number()), // Unix ms — when closer should reach out
  reminderNote: v.optional(v.string()),
  completedAt: v.optional(v.number()), // Unix ms — when closer marked complete

  reason: v.union(
    v.literal("closer_initiated"),
    v.literal("cancellation_follow_up"),
    v.literal("no_show_follow_up"),
  ),
  status: v.union(
    v.literal("pending"),
    v.literal("booked"),
    v.literal("completed"), // NEW status for manual reminders
    v.literal("expired"),
  ),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_closerId", ["tenantId", "closerId"])
  // NEW: Efficient query for dashboard reminders
  .index("by_tenantId_and_closerId_and_status", ["tenantId", "closerId", "status"]),
```

**Step 2: Add `personalEventTypeUri` to the `users` table**

Add the new field after `workosInvitationId` (line 74 in schema.ts), before the closing `})`:

```typescript
// Path: convex/schema.ts — BEFORE (users table, lines 73-75)
  // WorkOS invitation ID — used to revoke invitation if user is removed before sign-up.
  workosInvitationId: v.optional(v.string()),
})
```

```typescript
// Path: convex/schema.ts — AFTER (users table)
  // WorkOS invitation ID — used to revoke invitation if user is removed before sign-up.
  workosInvitationId: v.optional(v.string()),

  // Personal Calendly booking page URL for follow-up scheduling links.
  // Set by admin via Team settings page.
  // Example: "https://calendly.com/john-doe/30min"
  personalEventTypeUri: v.optional(v.string()),
})
```

**Key implementation notes:**
- All new fields are `v.optional(...)` — existing records remain valid without migration.
- The `type` field defaults to `undefined` for old records. Code should treat `undefined` as the legacy `"scheduling_link"` type.
- The `"completed"` status is new — only used by `manual_reminder` follow-ups. The existing `"booked"` status remains for scheduling link follow-ups.
- No new indexes needed on `users` — `personalEventTypeUri` is read by direct document lookup (`ctx.db.get(userId)`), not queried.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Widen `followUps` (6 new fields, 1 new status, 1 new index); add `personalEventTypeUri` to `users` |

---

### 1B — Register New Permissions

**Type:** Backend
**Parallelizable:** Yes — independent of schema changes (different file).

**What:** Add `"team:assign-event-type"`, `"follow-up:create"`, and `"follow-up:complete"` permissions to the `PERMISSIONS` object.

**Why:** Explicit permissions allow role-based access control for the new features. Even though closers are the only role that creates follow-ups today, explicit permissions enable future expansion without schema changes.

**Where:**
- `convex/lib/permissions.ts` (modify)

**How:**

**Step 1: Add the new permissions**

```typescript
// Path: convex/lib/permissions.ts — BEFORE
export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],
} as const;
```

```typescript
// Path: convex/lib/permissions.ts — AFTER
export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],
  // Feature A: Follow-Up & Rescheduling
  "team:assign-event-type": ["tenant_master", "tenant_admin"],
  "follow-up:create": ["closer"],
  "follow-up:complete": ["closer"],
} as const;
```

**Key implementation notes:**
- The `Permission` type auto-infers from the `as const` assertion — no additional type changes needed.
- `hasPermission()` function works unchanged with the new keys.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | Add 3 new permissions for Feature A |

---

### 1C — Follow-Up Queries (getActiveReminders)

**Type:** Backend
**Parallelizable:** Yes — independent of 1B. Depends on 1A schema types but can be written concurrently and will compile once schema is deployed.

**What:** Create `convex/closer/followUpQueries.ts` with the `getActiveReminders` query.

**Why:** The Reminders Dashboard Section (Phase 4) subscribes to this query via `useQuery`. It must return lead name, phone, and all reminder fields so the UI can render cards without additional queries.

**Where:**
- `convex/closer/followUpQueries.ts` (new)

**How:**

**Step 1: Create the query file**

```typescript
// Path: convex/closer/followUpQueries.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Get active manual reminder follow-ups for the current closer.
 * Returns pending reminders sorted by reminderScheduledAt (soonest first).
 * Enriched with lead name and phone for the dashboard cards.
 */
export const getActiveReminders = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const pendingFollowUps = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_closerId_and_status", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("closerId", userId)
          .eq("status", "pending"),
      )
      .take(50);

    // Filter to manual_reminder type only (undefined = legacy scheduling_link)
    const reminders = pendingFollowUps.filter(
      (f) => f.type === "manual_reminder",
    );

    // Enrich with lead data for dashboard cards
    const enriched = await Promise.all(
      reminders.map(async (reminder) => {
        const lead = await ctx.db.get(reminder.leadId);
        return {
          ...reminder,
          leadName: lead?.fullName ?? lead?.email ?? "Unknown",
          leadPhone: lead?.phone ?? null,
        };
      }),
    );

    // Sort by reminderScheduledAt ascending (soonest first)
    enriched.sort((a, b) => {
      const aTime = a.reminderScheduledAt ?? Infinity;
      const bTime = b.reminderScheduledAt ?? Infinity;
      return aTime - bTime;
    });

    console.log("[Closer:FollowUp] getActiveReminders", {
      userId,
      count: enriched.length,
    });

    return enriched;
  },
});
```

**Key implementation notes:**
- Uses the new `by_tenantId_and_closerId_and_status` index — no `.filter()` on the Convex query.
- Post-query `.filter()` for `type === "manual_reminder"` is acceptable because the index already narrows to max 50 results.
- Enrichment with `ctx.db.get(reminder.leadId)` is a point read per reminder — efficient for ≤50 items.
- Returns `leadPhone: string | null` — the UI needs this prominently for the "Call" / "Text" action.
- Client-side sorting is used because the index sorts by `status` not `reminderScheduledAt`. Fine for ≤50 items.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/followUpQueries.ts` | Create | `getActiveReminders` query for dashboard reminders |

---

### 1D — Public Mutations (createSchedulingLinkFollowUp, createManualReminderFollowUpPublic, markReminderComplete)

**Type:** Backend
**Parallelizable:** No — depends on 1A (schema types). Must complete before Phases 2-5 can wire UI/pipeline.

**What:** Add three new public mutations to the existing `convex/closer/followUpMutations.ts` file: `createSchedulingLinkFollowUp`, `createManualReminderFollowUpPublic`, and `markReminderComplete`.

**Why:** Phase 3 (dialog) calls `createSchedulingLinkFollowUp` and `createManualReminderFollowUpPublic`. Phase 4 (dashboard) calls `markReminderComplete`. These are public mutations (not actions) because no external API calls are needed.

**Where:**
- `convex/closer/followUpMutations.ts` (modify — file already exists with `createFollowUpRecord`, `transitionToFollowUp`, and `markFollowUpBooked`)

**How:**

**Step 1: Add imports for `mutation` and `requireTenantUser`**

The file currently imports only `internalMutation`. Add `mutation` and the tenant auth guard:

```typescript
// Path: convex/closer/followUpMutations.ts — BEFORE (lines 1-4)
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";
```

```typescript
// Path: convex/closer/followUpMutations.ts — AFTER (lines 1-5)
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";
import { requireTenantUser } from "../requireTenantUser";
```

**Step 2: Add `createSchedulingLinkFollowUp` mutation**

Append after the existing `markFollowUpBooked` mutation (after line 101):

```typescript
// Path: convex/closer/followUpMutations.ts (append after markFollowUpBooked)

/**
 * Create a scheduling link follow-up.
 * Reads the closer's personalEventTypeUri, constructs a URL with UTM params,
 * creates a followUp record, and transitions the opportunity to follow_up_scheduled.
 *
 * Replaces the old createFollowUp action — no Calendly API call needed.
 */
export const createSchedulingLinkFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  handler: async (ctx, { opportunityId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    if (!user.personalEventTypeUri) {
      throw new Error(
        "No personal calendar configured. Ask your admin to assign one in Team settings.",
      );
    }

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    // Create follow-up record first to get the ID for UTM params
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "scheduling_link",
      reason: "closer_initiated",
      status: "pending",
      createdAt: Date.now(),
    });

    // Construct the scheduling URL with UTM params
    const bookingPageUrl = user.personalEventTypeUri;
    const utmParams = new URLSearchParams({
      utm_source: "ptdom",
      utm_medium: "follow_up",
      utm_campaign: opportunityId,
      utm_content: followUpId,
      utm_term: userId,
    });
    const schedulingLinkUrl = `${bookingPageUrl}?${utmParams.toString()}`;

    // Store the URL on the follow-up record
    await ctx.db.patch(followUpId, { schedulingLinkUrl });

    // Transition opportunity
    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: Date.now(),
    });

    console.log("[Closer:FollowUp] scheduling link follow-up created", {
      followUpId,
      opportunityId,
      schedulingLinkUrl: schedulingLinkUrl.substring(0, 80) + "...",
    });

    return { schedulingLinkUrl, followUpId };
  },
});
```

**Step 3: Add `createManualReminderFollowUpPublic` mutation**

```typescript
// Path: convex/closer/followUpMutations.ts (append)

/**
 * Create a manual reminder follow-up.
 * Closer sets a reminder to call or text the lead at a specific time.
 */
export const createManualReminderFollowUpPublic = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    // Validate reminderScheduledAt is in the future
    if (args.reminderScheduledAt <= Date.now()) {
      throw new Error("Reminder time must be in the future");
    }

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "manual_reminder",
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
      reminderNote: args.reminderNote,
      reason: "closer_initiated",
      status: "pending",
      createdAt: Date.now(),
    });

    // Transition opportunity
    await ctx.db.patch(args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: Date.now(),
    });

    console.log("[Closer:FollowUp] manual reminder follow-up created", {
      followUpId,
      opportunityId: args.opportunityId,
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
    });

    return { followUpId };
  },
});
```

**Step 4: Add `markReminderComplete` mutation**

```typescript
// Path: convex/closer/followUpMutations.ts (append)

/**
 * Mark a manual reminder follow-up as complete.
 * Only the closer who owns the reminder can complete it.
 */
export const markReminderComplete = mutation({
  args: {
    followUpId: v.id("followUps"),
  },
  handler: async (ctx, { followUpId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const followUp = await ctx.db.get(followUpId);
    if (!followUp) throw new Error("Follow-up not found");
    if (followUp.tenantId !== tenantId) throw new Error("Access denied");
    if (followUp.closerId !== userId) throw new Error("Not your follow-up");
    if (followUp.type !== "manual_reminder") throw new Error("Not a manual reminder");
    if (followUp.status !== "pending") throw new Error("Follow-up is not pending");

    await ctx.db.patch(followUpId, {
      status: "completed",
      completedAt: Date.now(),
    });

    console.log("[Closer:FollowUp] reminder marked complete", { followUpId });
  },
});
```

**Key implementation notes:**
- `createSchedulingLinkFollowUp` is a **mutation** (not an action) — no external API call needed. The old `createFollowUp` action in `convex/closer/followUp.ts` can be deprecated but is left unchanged for backward compatibility.
- The follow-up record is inserted **before** the URL is constructed so the `followUpId` can be embedded in UTM params (`utm_content`).
- `markReminderComplete` checks 5 conditions: existence, tenant match, closer ownership, type, and status. Fail-loud for all violations.
- The existing `createFollowUpRecord`, `transitionToFollowUp`, and `markFollowUpBooked` internal mutations are **kept unchanged** for backward compatibility with the pipeline.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/followUpMutations.ts` | Modify | Add `mutation` + `requireTenantUser` imports; append 3 new public mutations |

---

### 1E — Deploy & Verify

**Type:** Manual / Config
**Parallelizable:** No — final verification step.

**What:** Deploy the schema changes and verify everything works.

**Why:** Schema deployment generates new TypeScript types. All functions must compile against the new schema.

**Where:**
- No file changes — verification only.

**How:**

**Step 1: Deploy schema**

```bash
npx convex dev
```

Verify the `followUps` table shows the new `by_tenantId_and_closerId_and_status` index in the Convex dashboard.

**Step 2: TypeScript compilation check**

```bash
pnpm tsc --noEmit
```

**Step 3: Verify existing records are unaffected**

In the Convex dashboard, confirm existing `followUps` records are still readable. The new fields show as `undefined` on existing records.

**Key implementation notes:**
- If `npx convex dev` fails with a schema validation error, invoke the `convex-migration-helper` skill.
- All new fields are `v.optional(...)` so the deploy should succeed without data migration.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/permissions.ts` | Modify | 1B |
| `convex/closer/followUpQueries.ts` | Create | 1C |
| `convex/closer/followUpMutations.ts` | Modify | 1D |

---

**Next Phase:** After Phase 1 is deployed, Phases 2, 3, 4, and 5 can start in parallel — they touch different files with no overlap.
