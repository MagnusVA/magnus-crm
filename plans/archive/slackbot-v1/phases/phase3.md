# Phase 3 — Lead, Opportunity & Slack-User Directory

**Goal:** Land the data model and write path. After this phase, a `view_submission` from Phase 2's modal lands in `convex/slack/createQualifiedLead.ts`, where it (1) calls a widened `resolveLeadIdentity` (now tolerating email-less leads), (2) inserts a new `opportunities` row with `source: "slack_qualified"` and `status: "qualified_pending"`, (3) attaches a `qualifiedBy` attribution object, and (4) lazy-upserts a `slackUsers` row. The `rawSlackEvents` audit trail is durable. Channel notifications (Phase 5) and the Calendly join (Phase 4) can both consume the new opportunity rows.

**Prerequisite:** Phase 1 + Phase 2 complete:
- `slackInstallations` + `slackOAuthStates` schema deployed (Phase 1 1B).
- `verifySlackSignature`, `getValidSlackBotToken`, `requireTenantUser`, `installations.byTeamIdAndAppId` available.
- `parseQualifyLeadSubmission` from `convex/lib/slackBlockKit.ts` (Phase 2 2A).
- `interactivity` handler exists and parses + acks submissions (Phase 2 2D); the "// PHASE 3 INSERT POINT" block is awaiting `createQualifiedLead.create`.
- The Phase 2 `rawEventsAudit.ts` no-op `persistRawSlackEvent` is in place; Phase 3 swaps it for a real DB writer.

**Runs in PARALLEL with:** Phase 4 starts the moment 3D is merged (the `qualified_pending` opportunity rows it needs to attach against are now writable). Phase 5's channel-config UI can also start once 3A's schema deploys (no overlap with the lead/opportunity layer).

> **Critical path:** This phase is on the critical path. The schema migration in 3A is the second-largest schema change in the project (after Phase 1's tables) and the **only one that widens existing prod tables** (`leads`, `leadIdentifiers`, `opportunities`, `opportunitySearch`). Per [`AGENTS.md`](../../../AGENTS.md), this requires the `convex-migration-helper` skill — widen-migrate-narrow rollout. Even though there are no data backfills, every reader of `lead.email` must tolerate `undefined` before the first Slack-qualified write lands.

**Skills to invoke:**
- **`convex-migration-helper`** — **REQUIRED** for 3A. Per [§10.10](../slackbot-design.md), this is the additive widen step. The skill orchestrates safety (deploy code that tolerates optional email *before* enabling the write that produces email-less leads), verifies schema compatibility, and provides the staging→prod rollout choreography appropriate for the test tenant currently in prod.
- **`convex-performance-audit`** — *recommended after 3D ships* — to validate the new composite index `by_tenantId_and_leadId_and_source_and_status_and_createdAt` is being hit by the dedup guard, not falling back to a full scan.
- **`design-doc-review`** — *recommended* — review §6 of the design doc against the implementation: the dedup guard, status transition table, and slackUsers normalization decisions. Catches scope drift while the data shape is still soft.

**Acceptance Criteria:**
1. After 3A deploys, `npx convex data leads | jq '.[].email'` shows existing rows still have email values; no row's email was nulled by the schema widen.
2. `npx convex data slackUsers` and `npx convex data rawSlackEvents` both print "No documents" — empty tables exist, and `rawSlackEvents` includes the optional `apiAppId` diagnostic field.
3. `resolveLeadIdentity({ tenantId, email: undefined, socialHandle: { platform: "instagram", rawValue: "@x" }, fullName: "Jane", … })` creates a new lead **without** email when no match exists, inserts social-handle identifiers, and does not try to insert an email identifier.
4. Calendly's existing `inviteeCreated.process` continues to function unchanged (regression check) — it always supplies email and the optional widening doesn't change its path.
5. Submitting the qualify-lead modal (Phase 2 2D) with full name + Instagram handle creates exactly one `opportunities` row with `status: "qualified_pending"`, `source: "slack_qualified"`, and `qualifiedBy: { slackUserId, slackTeamId, submittedAt }`. A new `leads` row is created when none matches; an existing lead is reused when the social handle matches.
6. Submitting twice within the dedup lookback window (default 30 days) returns `{ duplicate: true, existingOpportunityId }`; the user sees inline error: `"Already qualified by <@U…> N days ago."` Modal stays open.
7. Submitting from a Slack user the system has not seen before creates a **stub** row in `slackUsers` (with `lastSyncedAt: 0`) in the same transaction as the opportunity; an async `users.info` fetch enriches it only after commit.
8. The `rawSlackEvents` table receives one row per inbound HMAC-verified payload (slash command + view submission), with sensitive fields (`response_url`, `email`, `phone`, `real_name`) replaced by `<redacted:pii>` in `payloadRedacted`, a `requestHash: sha256(rawBody)`, and `apiAppId` when present.
9. `domainEvents` records an `opportunity.created` event with `metadata.source = "slack_qualified"` for every Phase 3 write — joinable with existing reporting aggregates without any reporting-side code change.
10. `pnpm tsc --noEmit` passes — `Doc<"slackUsers">`, `Doc<"rawSlackEvents">`, the widened `Doc<"leads">.email: string | undefined`, and the widened opportunity status / source unions all resolve.

---

## Subphase Dependency Graph

```
3A (schema widen — REQUIRES convex-migration-helper) ──────────────────────────┐
                                                                                │
                                                                                ├── 3B (status/source helper widening) ──┐
                                                                                ├── 3C (resolver widening + readers) ────┤
                                                                                ├── 3F (rawEvents real persistence) ─────┤
                                                                                │                                         ├── 3G (wire interactivity → createQualifiedLead)
                                                                                ├── 3D (createQualifiedLead mutation) ────┤
                                                                                └── 3E (slackUsers directory) ────────────┘
```

**Optimal execution:**

1. **Invoke `convex-migration-helper`** to plan 3A. The skill returns the widen-migrate-narrow schedule; for this phase the migrate and narrow are no-ops because no data needs backfill.
2. Build **3A + 3B + 3C** as the first deploy unit: schema widen, status/source helper widening, resolver widening, and reader fallbacks. Existing rows are unaffected, but code must tolerate the widened shape before the schema reaches prod.
3. After that first deploy is verified, **3F** (real rawSlackEvents persistence) and **3E** (slackUsers directory) can start in parallel — all touch different files and have no inter-dep.
4. After 3B + 3C are merged and verified, **3D** (createQualifiedLead) starts — depends on the widened resolver, the new status literal, and the `qualifiedBy` field.
5. **3E** can run in parallel with 3D only if the shared helper signature is agreed first. 3D must call a plain `upsertSlackUserOnSubmission(ctx, args)` helper from 3E, not `ctx.runMutation`, so the stub row participates in 3D's transaction.
6. **3G** (wire interactivity → createQualifiedLead) is the final stitch — once 3D + 3E ship, swap the "// PHASE 3 INSERT POINT" block in `convex/slack/interactivity.ts` for the real call. Single small PR.

**Estimated time:** 6–8 days. The schema deploy + reader audit (3A + 3C) is the slow part — every place in the codebase that does `lead.email` or assumes `opportunities.source !== undefined` must be checked. `convex-migration-helper` will produce a target list.

---

## Subphases

### 3A — Schema Widen (REQUIRES `convex-migration-helper`)

**Type:** Backend (schema migration)
**Parallelizable:** No — foundation; blocks 3D, 3E, 3F, 3G. It must be deployed together with 3B and 3C reader-tolerance code; do not deploy schema widening by itself.

**What:** A single additive Convex deploy that:
1. Adds two new tables: `slackUsers`, `rawSlackEvents`. (`slackInstallations` and `slackOAuthStates` were added in Phase 1 1B.)
2. Widens existing tables: `leads.email` becomes optional; `leadIdentifiers.source`, `opportunities.source`, `opportunities.status`, `opportunitySearch.source`, `opportunitySearch.status` each gain one new literal; `opportunities.qualifiedBy` is added as an optional object.
3. Adds two new composite indexes on `opportunities`: `by_tenantId_and_leadId_and_source_and_status_and_createdAt` (dedup/join guard) and `by_tenantId_and_source_and_status_and_createdAt` (status-scoped Slack queries such as stale reminders). Phase 6's all-status conversion metrics use the existing `by_tenantId_and_source_and_createdAt` index.
4. **Does not** remove or rename existing indexes — keeps every existing index name + field-set unchanged. New indexes are additive.

**Why:** Per [§10.10](../slackbot-design.md), this is the additive widen step. Existing rows remain valid because:
- `leads.email` becoming optional is backward-compatible: every existing row has a value.
- Adding a literal to a `v.union` widens the accepted set; existing values still satisfy.
- Adding optional fields (`qualifiedBy`) is non-breaking.

`convex-migration-helper` is invoked at the planning step to (a) confirm no row-level migration is needed, (b) produce the explicit per-file reader checklist for Phase 3B/3C, and (c) sequence the deploy so reader code that tolerates optional email lands in the same Convex deploy as the schema widening.

**Where:**
- `convex/schema.ts` (modify — additions only)

**How:**

**Step 1: Invoke `convex-migration-helper`**

Run the skill against the design's §10 (Data Model). The skill should produce, at minimum:

- A **widen plan** confirming this is one deploy, no data backfill, and identifying every reader of `lead.email` and `opportunities.source` / `opportunities.status` that must be audited.
- A **reader audit list** — every file path that `grep`s for `lead.email` (or destructures it), and every file that switches on `opportunity.source` or `opportunity.status`. Phase 3B/3C address this list.
- A **deploy plan**: ship schema + reader-tolerance code in the **same** deploy. Per [§10.10](../slackbot-design.md): "Do not deploy Slack writes until the optional-email readers and projections are live." 3D/3G are explicitly **separate** deploys.

The skill output is itself a deliverable — paste the reader audit into the PR description so reviewers can verify nothing was missed.

> **If `convex-migration-helper` is unavailable** (e.g. the skill repository isn't mounted), the manual fallback is `grep -rn '\\.email' app/ convex/ | grep -v node_modules | grep lead`. Cross-reference each match against `pnpm tsc --noEmit` after marking `email` optional in the schema. Better to invoke the skill — the audit is mechanical but error-prone.

**Step 2: Modify `convex/schema.ts` — widen `leads.email`**

```typescript
// Path: convex/schema.ts (locate the existing leads table definition)

// BEFORE:
leads: defineTable({
  // ...
  email: v.string(),  // currently required
  // ...
})

// AFTER:
leads: defineTable({
  // ...
  // Widened for Slack-qualified leads (slackbot-design.md §10.5).
  // Calendly-created leads still write email; Slack-created leads may begin with
  // only fullName + social handle. All readers must handle `lead.email === undefined`.
  email: v.optional(v.string()),
  // ...
})
  // EXISTING indexes — keep unchanged. The by_tenantId_and_email index now has a
  // sparse semantic; queries against it must handle undefined values gracefully.
```

**Step 3: Widen `leadIdentifiers.source`**

```typescript
// Path: convex/schema.ts (locate leadIdentifiers)

// BEFORE:
source: v.union(
  v.literal("calendly_booking"),
  v.literal("manual_entry"),
  v.literal("merge"),
  v.literal("side_deal"),
),

// AFTER:
source: v.union(
  v.literal("calendly_booking"),
  v.literal("manual_entry"),
  v.literal("merge"),
  v.literal("side_deal"),
  v.literal("slack_qualified"),       // NEW — Phase 3
),
```

**Step 4: Widen `opportunities.source`, `opportunities.status`, add `qualifiedBy`, add indexes**

```typescript
// Path: convex/schema.ts (locate opportunities)

// BEFORE source:
source: v.optional(v.union(
  v.literal("calendly"),
  v.literal("side_deal"),
)),

// AFTER:
source: v.optional(v.union(
  v.literal("calendly"),
  v.literal("side_deal"),
  v.literal("slack_qualified"),       // NEW
)),

// BEFORE status:
status: v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  // ... existing literals ...
),

// AFTER:
status: v.union(
  v.literal("qualified_pending"),     // NEW — pre-meeting state for slack_qualified opps
  v.literal("scheduled"),
  v.literal("in_progress"),
  // ... existing literals ...
),

// AFTER (add as a new field, after the existing source-related fields):
qualifiedBy: v.optional(v.object({
  slackUserId: v.string(),
  slackTeamId: v.string(),
  submittedAt: v.number(),
})),
```

```typescript
// Path: convex/schema.ts — add two new indexes to the opportunities table

// EXISTING — keep all current indexes unchanged.

// NEW — composite index used by the dedup guard in createQualifiedLead.
.index("by_tenantId_and_leadId_and_source_and_status_and_createdAt", [
  "tenantId",
  "leadId",
  "source",
  "status",
  "createdAt",
])

// NEW — composite index used by status-scoped Slack queries such as stale reminders.
// Phase 6's all-status conversion metrics use the existing
// by_tenantId_and_source_and_createdAt index.
.index("by_tenantId_and_source_and_status_and_createdAt", [
  "tenantId",
  "source",
  "status",
  "createdAt",
])
```

**Step 5: Widen `opportunitySearch.source` and `.status`**

```typescript
// Path: convex/schema.ts (locate opportunitySearch — projection table)

source: v.union(
  v.literal("calendly"),
  v.literal("side_deal"),
  v.literal("slack_qualified"),     // NEW
),

status: v.union(
  v.literal("qualified_pending"),   // NEW — first literal in the union (alphabetical or chronological — match opportunities.status order)
  v.literal("scheduled"),
  // ... existing literals ...
),
```

> **Order in the union literals doesn't affect Convex** but matters for diff readability — keep `opportunities.status` and `opportunitySearch.status` in identical order.

**Step 6: Add the two new tables**

```typescript
// Path: convex/schema.ts — append these two tables

  /**
   * Per-tenant Slack-user directory.
   * Lazy-populated on first /qualify-lead submission per slackbot-design.md §6.4.
   * Keeps display names current via `user_change` events (Phase 6) and a stale-row
   * sweep on access (>30 days since last sync triggers a re-fetch).
   *
   * Why normalized (not denormalized name on the opportunity): Slack display names
   * change. With this table, opportunities store only the immutable slackUserId
   * and dashboards join at render time. One user_change update refreshes every
   * historical attribution display.
   */
  slackUsers: defineTable({
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),

    // Slack identity (the join key from opportunities.qualifiedBy.slackUserId)
    slackUserId: v.string(),                    // e.g. "U214"
    slackTeamId: v.string(),

    // Profile snapshot — refreshed via users.info + user_change event
    username: v.optional(v.string()),           // .name (deprecated by Slack but populated)
    realName: v.optional(v.string()),           // .real_name
    displayName: v.optional(v.string()),        // .profile.display_name (preferred render)
    avatarUrl: v.optional(v.string()),          // .profile.image_72
    timezone: v.optional(v.string()),           // .tz (future per-user reminders)

    // Lifecycle
    isBot: v.boolean(),
    isDeleted: v.boolean(),                     // Slack-side soft delete

    // Optional cross-system mapping (reserved for v1.5+ — see §15 Open Q2)
    crmUserId: v.optional(v.id("users")),

    // Bookkeeping
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    lastSyncedAt: v.number(),                   // 0 = stub, never enriched yet
  })
    .index("by_tenantId_and_slackUserId", ["tenantId", "slackUserId"])  // upsert key
    .index("by_installationId_and_slackUserId", ["installationId", "slackUserId"])  // user_change trust boundary
    .index("by_slackTeamId_and_slackUserId", ["slackTeamId", "slackUserId"])  // diagnostics only
    .index("by_tenantId", ["tenantId"]),

  /**
   * Audit trail of inbound Slack events.
   * Per slackbot-design.md §13.7 — Slack inbound bodies can include PII and
   * temporary response_url webhook URLs. We store only the redacted envelope
   * plus a request hash for diagnostics / dup detection.
   *
   * Retention: 30 days (cleanup cron in Phase 6).
   */
  rawSlackEvents: defineTable({
    tenantId: v.optional(v.id("tenants")),      // null for events whose teamId we couldn't resolve
    teamId: v.string(),
    apiAppId: v.optional(v.string()),           // present on slash commands + Events API; diagnostics only
    eventType: v.string(),                      // "slash_command" | "view_submission" | "app_uninstalled" | …
    payloadRedacted: v.string(),                // JSON string — see rawEventsAudit.ts
    requestHash: v.string(),                    // sha256(rawBody) for diagnostics / duplicate detection
    slackEventId: v.optional(v.string()),       // Events API only
    receivedAt: v.number(),
    expiresAt: v.number(),                      // retention cutoff
    processed: v.boolean(),
    processingError: v.optional(v.string()),
  })
    .index("by_tenantId_and_processed", ["tenantId", "processed"])
    .index("by_teamId", ["teamId"])
    .index("by_teamId_and_apiAppId", ["teamId", "apiAppId"])
    .index("by_requestHash", ["requestHash"])
    .index("by_expiresAt", ["expiresAt"]),
```

**Step 7: Deploy the first migration unit and verify**

Deploy **3A + 3B + 3C together**. The schema widen is additive, but code must already tolerate `lead.email === undefined` and the widened source/status literals before any Slack-qualified write can land.

```bash
# Path: terminal — DEV first
npx convex dev
# Watch for any schema validation errors. The widen is additive — should succeed cleanly.

npx convex data slackUsers      # No documents
npx convex data rawSlackEvents  # No documents
npx convex data leads           # Existing rows unchanged; emails still present
npx convex data opportunities   # Existing rows unchanged

pnpm tsc --noEmit
```

**Step 8: Pre-prod manual checks (per [§6.6.1](../slackbot-design.md))**

> **You must run these checks against the dev deployment before promoting to prod.** This is a non-trivial schema change on a production deployment with one existing test tenant.

- [ ] `npx convex data slackOAuthStates` / `slackInstallations` / `rawSlackEvents` / `slackUsers` — confirm new tables exist and are empty.
- [ ] Verify the existing test tenant unaffected — spot-check existing `leads` + `opportunities` + `leadIdentifiers` via `npx convex data`. Existing emails should remain present; no row's `source` or `status` should have changed; the allowed sets have only widened.
- [ ] Confirm 3B + 3C are included in the same deploy as 3A. **Do not deploy 3A alone**, and do not deploy 3D/3G until the widened schema + reader fallbacks are verified.

**Step 9: Promote to prod**

After dev verification + 3B + 3C are merged + post-deploy regression checks pass:

```bash
npx convex deploy --prod
```

Spot-check the test tenant in prod the same way as Step 8.

**Key implementation notes:**
- **No data backfill in this phase.** Existing rows keep their existing email/source/status values. The allowed sets only widen.
- **Index additions on a populated table are O(N) at deploy time.** With one test tenant in prod, this is negligible. As tenant count grows, schedule schema deploys to off-peak hours.
- **`qualifiedBy` is intentionally a nested `v.object`, not a flat triple.** Future fields (e.g. `purpose: "follow_up"` per Open Q3) extend the nested object without polluting the top-level row.
- **Status order in the union matters only for review diff readability.** Convex treats unions as sets.
- **`opportunitySearch` is a projection table.** Per the survey, it has its own `searchIndex`. Widening its `source` + `status` keeps the projection accurate; otherwise an existing readers querying by source/status would silently miss Slack-qualified rows.
- **Per [§6.6.2](../slackbot-design.md):** Confirm `qualified_pending` is the chosen status name **before merging**. Once tenants accumulate `qualified_pending` rows in prod, renaming requires a follow-up data migration touching every Slack-sourced row. Bikeshed in a Slack thread first; alternatives considered: `pending_meeting`, `pre_meeting`, `qualified`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Widen `leads`, `leadIdentifiers`, `opportunities`, `opportunitySearch`; add `slackUsers`, `rawSlackEvents`; add 2 new opportunity indexes |
| (output of `convex-migration-helper`) | Read | Reader audit list — feeds 3B + 3C |

---

### 3B — Status / Source Helper Widening

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 3C, 3F. Depends on 3A.

**What:** Update three helper modules whose hand-rolled type unions have to mirror the schema widen, so TypeScript continues to typecheck and runtime guards continue to gate transitions correctly:

1. `convex/lib/sideDeals.ts` — `OpportunitySource` union widens to include `"slack_qualified"`.
2. `convex/lib/statusTransitions.ts` — `OPPORTUNITY_STATUSES` array adds `"qualified_pending"`; `VALID_TRANSITIONS` table adds the new entry node and its allowed transitions out (`scheduled`, `lost`).
3. `convex/lib/tenantStatsHelper.ts` — `ACTIVE_OPPORTUNITY_STATUSES` adds `"qualified_pending"` (these opps are open until booked or lost).

**Why:** Per [§10.8](../slackbot-design.md), the schema widen "is not limited to `opportunities`. The existing projection layer and helper types must be widened in the same deploy." Without these widenings, every site that switches on `OpportunityStatus` will fail to typecheck the new literal, *and* the state machine (per §10.9) will reject a `qualified_pending → scheduled` transition that Phase 4 will perform.

**Where:**
- `convex/lib/sideDeals.ts` (modify)
- `convex/lib/statusTransitions.ts` (modify)
- `convex/lib/tenantStatsHelper.ts` (modify)

**How:**

**Step 1: Widen `OpportunitySource` in `sideDeals.ts`**

```typescript
// Path: convex/lib/sideDeals.ts

// BEFORE:
export type OpportunitySource = "calendly" | "side_deal";

// AFTER:
export type OpportunitySource = "calendly" | "side_deal" | "slack_qualified";

// If sideDeals.ts has a runtime guard array, widen it too:
// BEFORE:
export const OPPORTUNITY_SOURCES = ["calendly", "side_deal"] as const;
// AFTER:
export const OPPORTUNITY_SOURCES = ["calendly", "side_deal", "slack_qualified"] as const;
```

**Step 2: Widen `statusTransitions.ts`**

```typescript
// Path: convex/lib/statusTransitions.ts (line ~26)

// BEFORE:
export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

// AFTER — qualified_pending is the entry node; add to the start.
export const OPPORTUNITY_STATUSES = [
  "qualified_pending",   // NEW — Phase 3 entry node for slack_qualified
  "scheduled",
  "in_progress",
  "meeting_overran",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

// VALID_TRANSITIONS — add qualified_pending row.
// BEFORE (excerpt):
export const VALID_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  scheduled: ["in_progress", "meeting_overran", "canceled", "no_show"],
  // ...
};

// AFTER:
export const VALID_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  qualified_pending: ["scheduled", "lost"],   // NEW — Phase 4 transitions to scheduled; manual mark to lost
  scheduled: ["in_progress", "meeting_overran", "canceled", "no_show"],
  // ... existing entries unchanged ...
};
```

**Step 3: Widen `tenantStatsHelper.ts`**

```typescript
// Path: convex/lib/tenantStatsHelper.ts

// BEFORE:
export const ACTIVE_OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const;

// AFTER:
export const ACTIVE_OPPORTUNITY_STATUSES = [
  "qualified_pending",   // NEW — open until booked or lost
  "scheduled",
  "in_progress",
  "meeting_overran",
  "follow_up_scheduled",
  "reschedule_link_sent",
] as const;
```

**Step 4: Verify and adjust callers**

```bash
# Path: terminal
pnpm tsc --noEmit
```

Expect a small fan-out of switch-statement non-exhaustiveness errors — wherever code switches on `OpportunityStatus`, TypeScript will now demand a case for `qualified_pending`. Most are filter UIs:

```typescript
// Path: e.g. app/workspace/pipeline/_components/pipeline-page-client.tsx
// BEFORE:
const statusLabels: Record<OpportunityStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In Progress",
  // ...
};

// AFTER:
const statusLabels: Record<OpportunityStatus, string> = {
  qualified_pending: "Qualified — pending meeting",   // NEW
  scheduled: "Scheduled",
  in_progress: "In Progress",
  // ...
};
```

Touch every file the compiler complains about. The label copy for `qualified_pending` is "Qualified — pending meeting" by default; product copy may change in Phase 5 / 6.

**Step 5: Verify no `validateTransition` regressions**

In a temporary action:

```typescript
// Path: convex/slack/_temp_transitionTest.ts (REMOVE after verification)
import { internalAction } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";

export const test = internalAction({
  args: {},
  handler: async () => {
    console.log("qp→sched:", validateTransition("qualified_pending", "scheduled")); // true
    console.log("qp→lost:", validateTransition("qualified_pending", "lost")); // true
    console.log("qp→in_prog:", validateTransition("qualified_pending", "in_progress")); // false
    console.log("sched→in_prog:", validateTransition("scheduled", "in_progress")); // true (regression check)
    return "ok";
  },
});
```

Run, observe, delete.

**Key implementation notes:**
- **Order matters in `OPPORTUNITY_STATUSES`** if any UI iterates over it for display ordering (e.g. a status filter dropdown). Putting `qualified_pending` first matches the lifecycle order. If a sorted display matters, a separate `STATUS_DISPLAY_ORDER` constant is appropriate; for now, lifecycle order is what we want.
- **`VALID_TRANSITIONS` is keyed on the *from* status.** A new entry node like `qualified_pending` adds *one* row. We do **not** need to add `qualified_pending` to other rows' allowed-targets unless a transition *into* `qualified_pending` from elsewhere is permitted (it isn't in v1).
- **The `lost` transition is enabled via manual mark or a future auto-age cron** (deferred per Open Q4). The state machine permits it; whether to expose a UI / cron is a separate decision.
- **`ACTIVE_OPPORTUNITY_STATUSES` drives `tenants.activeOpportunities` aggregation.** `qualified_pending` opps *are* active (open) until booked or lost; including them keeps the dashboard's "active deals" count accurate. If product wants a separate "qualified — not yet booked" stat, add a derived metric in Phase 6 rather than excluding from the active set here.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/sideDeals.ts` | Modify | Widen `OpportunitySource` union (+ runtime array if present) |
| `convex/lib/statusTransitions.ts` | Modify | Add `qualified_pending` to `OPPORTUNITY_STATUSES` + `VALID_TRANSITIONS` |
| `convex/lib/tenantStatsHelper.ts` | Modify | Add `qualified_pending` to `ACTIVE_OPPORTUNITY_STATUSES` |
| Various call-site files (UI labels, status filters) | Modify | Compiler will list — exhaustive switches need a `qualified_pending` case |

---

### 3C — `resolveLeadIdentity` Widening + Reader Fallbacks

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 3B, 3F. Depends on 3A.

**What:**
1. Widen `convex/leads/identityResolution.ts:resolveLeadIdentity` so `email` is optional. Allow `createIfMissing` when at least one normalized identifier exists (`email`, `socialHandle`, or `phone`). Slack v1 supplies the constraint that a normalized social handle is required when email is absent.
2. Update every reader of `lead.email` to fall back to `fullName ?? primaryIdentifier ?? lead._id` as the display string. Use the audit list from `convex-migration-helper` (3A Step 1) as the exhaustive checklist.
3. Update `syncLeadFromBooking` (Phase 4 reuses) to backfill `lead.email` from `inviteeEmail` when the matched lead was created without one.

**Why:** Per [§6.1](../slackbot-design.md): "current create path requires `email: string` and throws when a new lead has no email." Phase 3 must remove this throw without changing behavior for Calendly callers (who always pass email). The reader fallbacks are the **only** thing that prevents UI null-pointer rendering after a Slack-qualified lead exists in prod. **Until 3C is merged, 3D's first write would crash the pipeline UI.**

**Where:**
- `convex/leads/identityResolution.ts` (modify)
- Various reader files (per audit list)
- `convex/calendly/leadSync.ts` (or equivalent — check for `syncLeadFromBooking`) (modify)

**How:**

**Step 1: Widen `ResolveLeadIdentityArgs.email` to optional**

```typescript
// Path: convex/leads/identityResolution.ts (line ~28)

// BEFORE:
export type ResolveLeadIdentityArgs = {
  tenantId: Id<"tenants">;
  fullName?: string;
  email: string;                              // required
  phone?: string;
  socialHandle?: { platform: SocialPlatform; rawValue: string };
  identifierSource: LeadIdentifierSource;
  createdAt: number;
  createIfMissing?: boolean;
  createIdentifiers?: boolean;
};

// AFTER:
export type ResolveLeadIdentityArgs = {
  tenantId: Id<"tenants">;
  fullName?: string;
  email?: string;                             // OPTIONAL — Phase 3
  phone?: string;
  socialHandle?: { platform: SocialPlatform; rawValue: string };
  identifierSource: LeadIdentifierSource;
  createdAt: number;
  createIfMissing?: boolean;
  createIdentifiers?: boolean;
};
```

**Step 2: Widen the resolver body (line ~282)**

```typescript
// Path: convex/leads/identityResolution.ts (within resolveLeadIdentity)

// BEFORE — assumes email always present:
const normalizedEmail = normalizeEmail(args.email);
const existingByEmail = await ctx.db
  .query("leads")
  .withIndex("by_tenantId_and_email", (q) =>
    q.eq("tenantId", args.tenantId).eq("email", normalizedEmail))
  .unique();
if (existingByEmail) { /* match by email */ }
// ... fallthrough to social-handle / phone matching ...

// AFTER:
const normalizedEmail = args.email ? normalizeEmail(args.email) : undefined;
let existingByEmail: Doc<"leads"> | null = null;
if (normalizedEmail) {
  existingByEmail = await ctx.db
    .query("leads")
    .withIndex("by_tenantId_and_email", (q) =>
      q.eq("tenantId", args.tenantId).eq("email", normalizedEmail))
    .unique();
}
if (existingByEmail) { /* match by email */ }
// ... fallthrough unchanged — social-handle / phone matching already runs as a fallback ...
```

**Step 3: Allow `createIfMissing` without email**

```typescript
// Path: convex/leads/identityResolution.ts (within the create branch)

// BEFORE — assumes args.email is non-empty:
const leadId = await ctx.db.insert("leads", {
  tenantId: args.tenantId,
  email: normalizedEmail,
  fullName: args.fullName,
  // ... other fields ...
});

// AFTER:
// Validate at least one identifier exists. Slack v1 enforces this at the modal level
// (handle is required), but the resolver is the structural guard.
const hasIdentifier =
  Boolean(normalizedEmail) ||
  Boolean(args.socialHandle?.rawValue) ||
  Boolean(args.phone);
if (!hasIdentifier) {
  throw new Error(
    "Cannot create lead — at least one of email, socialHandle, or phone is required",
  );
}

const leadId = await ctx.db.insert("leads", {
  tenantId: args.tenantId,
  email: normalizedEmail,                   // undefined when no email supplied
  fullName: args.fullName,
  // ... other fields ...
});

// `leadIdentifiers` rows are inserted regardless of email — handled below.
```

**Step 3.5: Make identifier creation email-aware**

The current helper unconditionally requires and inserts an email identifier. Patch it in the same file; otherwise email-less Slack leads will compile at the schema layer but still throw at runtime.

```typescript
// Path: convex/leads/identityResolution.ts

// BEFORE:
async function createManualIdentifiers(ctx, args: {
  tenantId: Id<"tenants">;
  leadId: Id<"leads">;
  email: string;
  rawEmail: string;
  phone?: string;
  socialHandle?: SocialHandleInput;
  source: IdentifierSource;
  createdAt: number;
}) {
  await insertLeadIdentifierIfMissing(ctx, {
    type: "email",
    value: args.email,
    rawValue: args.rawEmail,
    // ...
  });
  // phone/social insertions...
}

// AFTER:
async function createManualIdentifiers(ctx: MutationCtx, args: {
  tenantId: Id<"tenants">;
  leadId: Id<"leads">;
  email?: string;
  rawEmail?: string;
  phone?: string;
  socialHandle?: SocialHandleInput;
  source: IdentifierSource;
  createdAt: number;
}) {
  if (args.email && args.rawEmail) {
    await insertLeadIdentifierIfMissing(ctx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      type: "email",
      value: args.email,
      rawValue: args.rawEmail,
      source: args.source,
      confidence: "verified",
      createdAt: args.createdAt,
    });
  }
  // Existing phone/social branches stay, but they must not depend on email.
}
```

Also patch the new-lead branch:

```typescript
// Path: convex/leads/identityResolution.ts

const socialHandles = await createManualIdentifiers(ctx, {
  tenantId: args.tenantId,
  leadId,
  email: normalizedEmail,
  rawEmail: args.email,
  phone,
  socialHandle: args.socialHandle,
  source: args.identifierSource,
  createdAt: args.createdAt,
});

const identifierValues = [
  normalizedEmail,
  phone ? normalizePhone(phone) : undefined,
  args.socialHandle
    ? normalizeSocialHandle(args.socialHandle.platform, args.socialHandle.rawValue)
    : undefined,
].filter((value): value is string => Boolean(value));

const potentialDuplicateLeadId = normalizedEmail
  ? await detectPotentialDuplicate(ctx, args.tenantId, fullName, normalizedEmail, leadId)
  : undefined;
```

Do not call `detectPotentialDuplicate` without an email domain; its current implementation is name+domain based.

**Step 4: Reader fallback pattern**

For every reader on the audit list, replace:

```typescript
// BEFORE:
const display = lead.email;
```

with:

```typescript
// AFTER:
function leadDisplayString(lead: Doc<"leads">, identifiers?: Doc<"leadIdentifiers">[]) {
  if (lead.fullName) return lead.fullName;
  if (lead.email) return lead.email;
  // Pick the highest-confidence identifier as a fallback display.
  if (identifiers && identifiers.length > 0) {
    const ranked = [...identifiers].sort(byConfidence);
    return formatIdentifier(ranked[0]);     // e.g. "@instahandle (Instagram)"
  }
  return `Lead ${lead._id.slice(-6)}`;       // last-resort opaque
}

// Use it everywhere previously assuming lead.email is defined.
const display = leadDisplayString(lead, identifiers);
```

Centralize `leadDisplayString` in a shared helper:

```typescript
// Path: convex/lib/leadDisplay.ts (new)

import type { Doc } from "../_generated/dataModel";
import { SOCIAL_PLATFORM_LABELS } from "./socialPlatform";

export function leadDisplayString(
  lead: Doc<"leads">,
  identifiers?: Doc<"leadIdentifiers">[],
): string {
  if (lead.fullName && lead.fullName.trim().length > 0) return lead.fullName;
  if (lead.email) return lead.email;

  if (identifiers && identifiers.length > 0) {
    const ranked = [...identifiers].sort((a, b) => {
      // Confidence ranking: verified > inferred > suggested
      const score = (c: string) => (c === "verified" ? 0 : c === "inferred" ? 1 : 2);
      return score(a.confidence) - score(b.confidence);
    });
    const top = ranked[0];
    if (top.type === "email") return top.rawValue;
    if (top.type === "phone") return top.rawValue;
    const platformLabel = SOCIAL_PLATFORM_LABELS[top.type as keyof typeof SOCIAL_PLATFORM_LABELS];
    return platformLabel ? `${top.rawValue} (${platformLabel})` : top.rawValue;
  }
  return `Lead ${lead._id.slice(-6)}`;
}

/**
 * Frontend variant — accepts identifiers as already-fetched by an RSC.
 * Same fallback hierarchy.
 */
export function leadDisplayFromShape(args: {
  fullName?: string;
  email?: string;
  primaryIdentifier?: { type: string; rawValue: string };
  leadIdSuffix?: string;
}): string {
  if (args.fullName && args.fullName.trim().length > 0) return args.fullName;
  if (args.email) return args.email;
  if (args.primaryIdentifier) {
    const platformLabel = SOCIAL_PLATFORM_LABELS[
      args.primaryIdentifier.type as keyof typeof SOCIAL_PLATFORM_LABELS
    ];
    return platformLabel
      ? `${args.primaryIdentifier.rawValue} (${platformLabel})`
      : args.primaryIdentifier.rawValue;
  }
  return args.leadIdSuffix ? `Lead ${args.leadIdSuffix}` : "Lead";
}
```

Migrate every reader call site to use `leadDisplayString` / `leadDisplayFromShape`. The `convex-migration-helper` audit list from 3A is the exhaustive set.

**Step 5: Widen `buildLeadSearchText`**

If `convex/leads/buildSearchText.ts` (or wherever) builds the searchText for `opportunitySearch`, it likely concatenates email. Patch:

```typescript
// BEFORE (excerpt):
const text = [lead.fullName, lead.email, lead.phone].filter(Boolean).join(" ");

// AFTER:
const identifierTexts = await getLeadIdentifierTexts(ctx, lead._id);  // sorted by confidence
const text = [
  lead.fullName,
  lead.email,
  lead.phone,
  ...identifierTexts,
].filter(Boolean).join(" ");
```

This means social-handle searches in the existing search bar (`/workspace/pipeline?q=@jane`) will start matching email-less Slack-qualified leads.

**Step 6: Patch `syncLeadFromBooking` (Phase 4 reuses)**

Per [§7.2](../slackbot-design.md): "If the Slack-created lead had no email, syncLeadFromBooking should patch lead.email from inviteeEmail before lead search text is refreshed."

Locate `syncLeadFromBooking` (likely `convex/calendly/leadSync.ts` or `convex/pipeline/inviteeCreated.ts`). At the top of the patch block:

```typescript
// Path: e.g. convex/calendly/leadSync.ts
// AFTER existing patch logic, BEFORE updating search text:

const normalizedInviteeEmail = inviteeEmail ? normalizeEmail(inviteeEmail) : undefined;
if (!matchedLead.email && normalizedInviteeEmail) {
  await ctx.db.patch(matchedLead._id, { email: normalizedInviteeEmail });
  // Also insert a verified email identifier (canonical provenance: calendly_booking).
  await insertLeadIdentifierIfMissing(ctx, {
    tenantId: matchedLead.tenantId,
    leadId: matchedLead._id,
    type: "email",
    value: normalizedInviteeEmail,
    rawValue: inviteeEmail,
    source: "calendly_booking",
    confidence: "verified",
    createdAt: Date.now(),
  });
}
```

This is exactly the join behavior described in §7 — Phase 4 doesn't need to add it; Phase 3 makes it correct.

**Step 7: Verify**

```bash
pnpm tsc --noEmit
```

If anything still types `lead.email: string` (instead of `string | undefined`), the audit missed a file. Re-run `convex-migration-helper` or grep manually.

**Key implementation notes:**
- **The compiler will surface every reader.** This is the value of the schema-as-types model — there's no need to manually grep when `pnpm tsc --noEmit` produces a complete list of problems. Use this as the master to-do list for the subphase.
- **Calendly callers are unchanged.** They always pass email; the `email?: string` widening doesn't change their behavior. Verify with a regression test on the existing Calendly path (Phase 3 4.1 in the design doc covers this).
- **The `Cannot create lead — at least one of … is required` throw is intentional.** Phase 3D's modal-level guard ensures it's never hit from Slack; defense-in-depth at the resolver guards against other future callers.
- **`leadDisplayString` is a small change with broad reach.** Land it first in the helper file, then migrate one call site at a time so individual diffs stay reviewable.
- **Search text refresh on email backfill** — once `syncLeadFromBooking` patches email, also call the existing `refreshOpportunitySearchForLead` (or equivalent) to keep `opportunitySearch.searchText` accurate.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/identityResolution.ts` | Modify | `email?` → optional; create-branch validation |
| `convex/lib/leadDisplay.ts` | Create | Centralized display fallback |
| `convex/leads/buildSearchText.ts` (or equivalent) | Modify | Include identifier text in projection |
| `convex/calendly/leadSync.ts` (or equivalent) | Modify | Backfill email on Slack-then-Calendly join |
| Multiple UI / query files | Modify | Per `convex-migration-helper` audit list — replace `lead.email` with `leadDisplayString` fallback |

---

### 3D — `createQualifiedLead` Mutation

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 3E. Depends on 3A, 3B, 3C. Blocks 3G.

**What:** The internal mutation called from `convex/slack/interactivity.ts` on a successful `view_submission`. Six side effects in one transaction:

1. Resolve lead identity via the widened `resolveLeadIdentity`.
2. Run the dedup guard against the new composite index.
3. Insert the `opportunities` row with `source: "slack_qualified"`, `status: "qualified_pending"`, `qualifiedBy`.
4. Run the existing reporting write-hooks: `insertOpportunityAggregate`, `updateTenantStats`, `emitDomainEvent`.
5. Lazy-upsert the `slackUsers` stub row + schedule the `users.info` enrich (from 3E).
6. Schedule the channel confirmation (from Phase 5) — non-blocking after commit.

**Why:** This is the centerpiece of Phase 3. Per [§6.2](../slackbot-design.md), the design specifies the exact write order so dashboards, search, reporting aggregates, and domain events all stay consistent with the Calendly-created opportunity path. Rolling those side effects together in one mutation gives us the same atomicity the existing pipeline gets.

**Where:**
- `convex/slack/createQualifiedLead.ts` (new)

**How:**

**Step 1: Implement the mutation**

```typescript
// Path: convex/slack/createQualifiedLead.ts

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { resolveLeadIdentity } from "../leads/identityResolution";
import { socialPlatformValidator } from "../lib/socialPlatform";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { emitDomainEvent } from "../lib/domainEvents";
import { upsertSlackUserOnSubmission } from "./users";

const SLACK_DEDUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — see §6.2 / §7.3

/**
 * Create a Slack-qualified opportunity from a /qualify-lead view_submission.
 *
 * Idempotency:
 *   - Lead resolution reuses an existing lead when email or social handle matches.
 *   - Dedup guard returns `{ duplicate: true, existingOpportunityId }` when the same
 *     lead has an open qualified_pending opportunity within the lookback window.
 *
 * Atomicity:
 *   - All DB writes happen in this single mutation. Any throw rolls everything back.
 *   - Side-effects that aren't required for consistency (slackUsers enrich,
 *     channel confirmation) go on `ctx.scheduler.runAfter(0, …)` after the
 *     transaction commits.
 */
export const create = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    installationId: v.id("slackInstallations"),
    fullName: v.string(),
    platform: socialPlatformValidator,
    handle: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    qualifiedBy: v.object({
      slackUserId: v.string(),
      slackTeamId: v.string(),
      submittedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // ── 1. Lead identity resolution ───────────────────────────────────────
    const resolution = await resolveLeadIdentity(ctx, {
      tenantId: args.tenantId,
      email: args.email,
      socialHandle: { platform: args.platform, rawValue: args.handle },
      phone: args.phone,
      fullName: args.fullName,
      identifierSource: "slack_qualified",  // NEW literal — see 3A schema widen
      createIfMissing: true,
      createIdentifiers: true,
      createdAt: now,
    });
    console.log("[Slack:CreateQL] lead resolved", {
      tenantId: args.tenantId,
      leadId: resolution.leadId,
      created: resolution.isNewLead,
      via: resolution.resolvedVia,
    });

    // ── 2. Dedup guard ────────────────────────────────────────────────────
    // Look for an open qualified_pending opportunity for this lead within the
    // lookback window. If found, abort with a structured response so the modal
    // can render an inline error.
    const lookbackCutoff = now - SLACK_DEDUP_LOOKBACK_MS;
    const recent = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId_and_source_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("leadId", resolution.leadId)
          .eq("source", "slack_qualified")
          .eq("status", "qualified_pending")
          .gt("createdAt", lookbackCutoff))
      .order("desc")
      .first();

    if (recent) {
      console.warn("[Slack:CreateQL] dedup hit", {
        tenantId: args.tenantId,
        leadId: resolution.leadId,
        existingOpportunityId: recent._id,
        priorSubmitter: recent.qualifiedBy?.slackUserId,
      });
      return {
        duplicate: true as const,
        existingOpportunityId: recent._id,
        priorQualifiedBy: recent.qualifiedBy ?? null,
      };
    }

    // v1 policy: do not create a new Slack-qualified opportunity when this
    // lead already has an active/booked CRM opportunity. Future follow-up
    // qualification can be modeled with an explicit `purpose` field.
    const existingOppsForLead = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", resolution.leadId))
      .take(20);
    const alreadyBooked = existingOppsForLead.find((o) =>
      o.status !== "lost" && o.status !== "canceled" && o.status !== "no_show");
    if (alreadyBooked) {
      return {
        duplicate: true as const,
        existingOpportunityId: alreadyBooked._id,
        priorQualifiedBy: alreadyBooked.qualifiedBy ?? null,
        alreadyBooked: alreadyBooked.status !== "qualified_pending",
      };
    }

    // ── 3. Insert the opportunity ─────────────────────────────────────────
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: args.tenantId,
      leadId: resolution.leadId,
      status: "qualified_pending",
      source: "slack_qualified",
      createdAt: now,
      updatedAt: now,
      latestActivityAt: now,
      qualifiedBy: args.qualifiedBy,
      // Existing required/optional fields keep defaults — refer to convex/schema.ts.
      // If your schema requires an explicit `priority` / `currency` / etc., set defaults here.
    });
    console.log("[Slack:CreateQL] opportunity inserted", {
      tenantId: args.tenantId,
      opportunityId,
      leadId: resolution.leadId,
    });

    // ── 4. Reporting write-hooks (same as Calendly path) ──────────────────
    await insertOpportunityAggregate(ctx, opportunityId);
    await updateTenantStats(ctx, args.tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,    // qualified_pending is in ACTIVE_OPPORTUNITY_STATUSES (3B)
    });
    await emitDomainEvent(ctx, {
      tenantId: args.tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.created",
      source: "pipeline",
      toStatus: "qualified_pending",
      occurredAt: now,
      metadata: { source: "slack_qualified" },
    });

    // ── 5. slackUsers lazy upsert (synchronous part — stub row only) ──────
    // The async `users.info` enrich is scheduled via runAfter(0, …) by the helper.
    await upsertSlackUserOnSubmission(ctx, {
      tenantId: args.tenantId,
      slackUserId: args.qualifiedBy.slackUserId,
      slackTeamId: args.qualifiedBy.slackTeamId,
      installationId: args.installationId,
      now,
    });

    // ── 6. Schedule channel confirmation (Phase 5 — non-blocking) ─────────
    // Phase 5's `internal.slack.notify.postConfirmation` reads notifyChannelId
    // off slackInstallations; if not yet configured, the action no-ops.
    await ctx.scheduler.runAfter(0, internal.slack.notify.postConfirmation, {
      tenantId: args.tenantId,
      opportunityId,
      leadId: resolution.leadId,
    });

    return {
      duplicate: false as const,
      opportunityId,
      leadId: resolution.leadId,
      isNewLead: resolution.isNewLead,
      resolvedVia: resolution.resolvedVia,
    };
  },
});
```

**Step 2: Forward-declare `internal.slack.notify.postConfirmation`**

Phase 5 lands the real implementation; Phase 3 needs at least the signature so 3D's `runAfter` typechecks.

```typescript
// Path: convex/slack/notify.ts (NEW — stub for Phase 5)
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

/**
 * STUB — Phase 5 lands the real implementation. Phase 3's createQualifiedLead
 * schedules this action via runAfter(0). For Phase 3 it logs and no-ops; once
 * Phase 5 ships, it will call chat.postMessage via the local Slack Web API helper.
 */
export const postConfirmation = internalAction({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
  },
  handler: async (_ctx, args) => {
    console.log("[Slack:Notify] (Phase 3 stub) postConfirmation", args);
  },
});
```

**Step 3: Verify with a synthetic call**

```typescript
// Path: convex/slack/_temp_createQLTest.ts (REMOVE after verification)
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const test = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, args) => {
    const installation = await ctx.runQuery(internal.slack.installations.byTenantId, {
      tenantId: args.tenantId,
    });
    if (!installation) throw new Error("Install Slack before running this smoke test.");

    const r = await ctx.runMutation(internal.slack.createQualifiedLead.create, {
      tenantId: args.tenantId,
      installationId: installation._id,
      fullName: "Jane Test",
      platform: "instagram",
      handle: "@janetest",
      qualifiedBy: {
        slackUserId: "U_TEST",
        slackTeamId: "T_TEST",
        submittedAt: Date.now(),
      },
    });
    return r;
  },
});
```

```bash
# Path: terminal
npx convex run slack/_temp_createQLTest:test '{"tenantId":"<dev-tenant-id>"}'
# First call: { duplicate: false, opportunityId, leadId, isNewLead: true, ... }
# Second call: { duplicate: true, existingOpportunityId, priorQualifiedBy: {...} }

npx convex data opportunities | grep slack_qualified
# Should show one row.

npx convex data leads | tail -3
# New lead row with email: undefined.
```

**Delete `_temp_createQLTest.ts`** after verification.

**Key implementation notes:**
- **`createQualifiedLead.create` is `internalMutation`, not `mutation`.** It's only called from `convex/slack/interactivity.ts` (and the test action). External access is meaningless.
- **The dedup guard uses `.first()` not `.unique()`.** A lead might have multiple `qualified_pending` rows in pathological cases (e.g. data migration); we want the most recent.
- **`recent.qualifiedBy?.slackUserId`** — the `?` is structural defense in case of a row written before `qualifiedBy` was added. (Shouldn't happen post-3A but cheap to guard.)
- **`ACTIVE_OPPORTUNITY_STATUSES` includes `qualified_pending`** (3B) — so `updateTenantStats` increments `activeOpportunities`. This is intentional. Phase 4's transition to `scheduled` doesn't change the active count.
- **The `runAfter(0, postConfirmation, …)` is scheduled inside the mutation.** Per Convex docs, the scheduled call runs after the mutation commits — so if the mutation rolls back, no spurious channel post fires.
- **`upsertSlackUserOnSubmission` is a plain helper, not `ctx.runMutation`.** Calling an internal mutation from here would split the write into a separate transaction and break the atomicity guarantee above.
- **`metadata: { source: "slack_qualified" }`** in the domain event — joinable by reporting queries that filter on metadata.
- **Why don't we use `validateTransition` here?** Because this is the *initial* insert, not a transition. There is no "from" status. Phase 4's join *does* use `validateTransition("qualified_pending", "scheduled")`.
- **What if `resolveLeadIdentity` throws "potentialDuplicateLeadId" handling?** Per [§14.7](../slackbot-design.md), v1 accepts the resolver's best-guess match; we flag in `domainEvents` for ops review (deferred to v1.1 surface). For now, the resolver returns `potentialDuplicateLeadId` as part of the result; we ignore it. If it's noisy in practice, surface in the integrations page.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/createQualifiedLead.ts` | Create | The mutation |
| `convex/slack/notify.ts` | Create | Stub for Phase 5 — keeps 3D's `runAfter` typechecking |

---

### 3E — `slackUsers` Directory: Lazy Upsert + Async Enrich

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 3D. Depends on 3A.

**What:** Slack user directory primitives split across two files so async Slack Web API calls never share a Convex module with queries/mutations:
1. `convex/slack/users.ts`: `upsertSlackUserOnSubmission` plain helper, `upsertOnSubmission` wrapper, `applyProfile`, `handleUserChange`, `_byId`, and `byTenantAndSlackUserId`.
2. `convex/slack/userActions.ts`: `fetchAndSync` internal action, which calls `users.info` via `convex/slack/webApi.ts` and hands the response to `users.applyProfile`.

**Why:** Per [§6.4](../slackbot-design.md), the directory is normalized so display names refresh without re-writing every historical opportunity row. The helper pattern lets `createQualifiedLead.create` keep the opportunity + stub row atomic; enrichment happens out-of-band.

**Where:**
- `convex/slack/users.ts` (new — queries/mutations/helpers only; no `"use node"`)
- `convex/slack/userActions.ts` (new — action using the local Slack Web API `fetch` helper)

**How:**

**Step 1: Implement the lookup query and lazy upsert mutation**

```typescript
// Path: convex/slack/users.ts

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/* ────────────────────────────────────────────────────────────────────────── */
/* Lookups                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export const byTenantAndSlackUserId = internalQuery({
  args: { tenantId: v.id("tenants"), slackUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("slackUserId", args.slackUserId))
      .unique();
  },
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Lazy upsert from /qualify-lead submission                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const STALE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type UpsertOnSubmissionArgs = {
  tenantId: Id<"tenants">;
  slackUserId: string;
  slackTeamId: string;
  installationId: Id<"slackInstallations">;
  now: number;
};

/**
 * Plain helper used by createQualifiedLead so the stub row is written in the
 * same mutation transaction as the opportunity.
 */
export async function upsertSlackUserOnSubmission(
  ctx: MutationCtx,
  args: UpsertOnSubmissionArgs,
) {
  const existing = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId_and_slackUserId", (q) =>
      q.eq("tenantId", args.tenantId).eq("slackUserId", args.slackUserId))
    .unique();

  if (!existing) {
    // Stub row — display falls back to slackUserId until enriched.
    const id = await ctx.db.insert("slackUsers", {
      tenantId: args.tenantId,
      installationId: args.installationId,
      slackUserId: args.slackUserId,
      slackTeamId: args.slackTeamId,
      username: undefined,
      realName: undefined,
      displayName: undefined,
      avatarUrl: undefined,
      timezone: undefined,
      isBot: false,
      isDeleted: false,
      crmUserId: undefined,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
      lastSyncedAt: 0, // 0 = never enriched — schedule fetchAndSync below
    });
    // Enrich after the surrounding mutation commits.
    await ctx.scheduler.runAfter(0, internal.slack.userActions.fetchAndSync, {
      slackUserRowId: id,
    });
    console.log("[Slack:Users] stub inserted", { tenantId: args.tenantId, slackUserId: args.slackUserId });
    return id;
  }

  // Existing row — bump lastSeenAt; trigger refresh if stale.
  const patch: Partial<Doc<"slackUsers">> = { lastSeenAt: args.now };
  await ctx.db.patch(existing._id, patch);

  if (args.now - existing.lastSyncedAt > STALE_REFRESH_MS) {
    await ctx.scheduler.runAfter(0, internal.slack.userActions.fetchAndSync, {
      slackUserRowId: existing._id,
    });
  }
  return existing._id;
}

/**
 * Wrapper for tests/manual maintenance. Do not call this from
 * createQualifiedLead; that would split the transaction.
 */
export const upsertOnSubmission = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    slackUserId: v.string(),
    slackTeamId: v.string(),
    installationId: v.id("slackInstallations"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    return await upsertSlackUserOnSubmission(ctx, args);
  },
});

```

**Step 2: Implement the async enrich action**

```typescript
// Path: convex/slack/userActions.ts
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getValidSlackBotToken } from "./tokens";
import { slackApiGet } from "./webApi";

/* ────────────────────────────────────────────────────────────────────────── */
/* Async enrich via slack.users.info                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export const fetchAndSync = internalAction({
  args: { slackUserRowId: v.id("slackUsers") },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.slack.users._byId, { id: args.slackUserRowId });
    if (!row) return;

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, row.tenantId);
    } catch (e) {
      console.warn("[Slack:Users] enrich token unavailable", {
        slackUserRowId: args.slackUserRowId, err: e instanceof Error ? e.message : "unknown",
      });
      return;
    }

    try {
      // Per .docs/slack/users-info.md
      const r = await slackApiGet<{ user?: SlackUserInfo }>(
        "users.info",
        token,
        { user: row.slackUserId },
      );
      if (!r.ok || !r.user) {
        console.warn("[Slack:Users] users.info returned !ok", {
          slackUserRowId: args.slackUserRowId,
          error: r.error ?? "unknown",
        });
        return;
      }

      const u = r.user;
      await ctx.runMutation(internal.slack.users.applyProfile, {
        id: args.slackUserRowId,
        username: u.name ?? undefined,
        realName: u.real_name ?? undefined,
        displayName: u.profile?.display_name ?? undefined,
        avatarUrl: u.profile?.image_72 ?? undefined,
        timezone: u.tz ?? undefined,
        isBot: Boolean(u.is_bot),
        isDeleted: Boolean(u.deleted),
        syncedAt: Date.now(),
      });
      console.log("[Slack:Users] enriched", { slackUserRowId: args.slackUserRowId });
    } catch (e) {
      console.error("[Slack:Users] users.info threw", {
        slackUserRowId: args.slackUserRowId,
        err: e instanceof Error ? e.message : "unknown",
      });
      // Best-effort — don't propagate. The row stays at lastSyncedAt: 0 and gets retried
      // on the next access (because 0 < now - STALE_REFRESH_MS is always true).
    }
  },
});
```

**Step 3: Keep profile mutations in the non-Node users module**

```typescript
// Path: convex/slack/users.ts

export const applyProfile = internalMutation({
  args: {
    id: v.id("slackUsers"),
    username: v.optional(v.string()),
    realName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    timezone: v.optional(v.string()),
    isBot: v.boolean(),
    isDeleted: v.boolean(),
    syncedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      username: args.username,
      realName: args.realName,
      displayName: args.displayName,
      avatarUrl: args.avatarUrl,
      timezone: args.timezone,
      isBot: args.isBot,
      isDeleted: args.isDeleted,
      lastSyncedAt: args.syncedAt,
    });
  },
});

/* ────────────────────────────────────────────────────────────────────────── */
/* user_change event handler (Phase 6 dispatches into here)                   */
/* ────────────────────────────────────────────────────────────────────────── */

export const handleUserChange = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    userPayload: v.any(), // Slack delivers the full users.info-shaped object
  },
  handler: async (ctx, args) => {
    const u = args.userPayload as {
      id?: string;
      name?: string;
      real_name?: string;
      profile?: { display_name?: string; image_72?: string };
      tz?: string;
      is_bot?: boolean;
      deleted?: boolean;
    };
    const slackUserId = u?.id as string | undefined;
    if (!slackUserId) return;

    // The Events API handler already resolved (team_id, api_app_id) to an
    // installation. Update only that installation's row.
    const row = await ctx.db
      .query("slackUsers")
      .withIndex("by_installationId_and_slackUserId", (q) =>
        q.eq("installationId", args.installationId).eq("slackUserId", slackUserId))
      .unique();

    if (!row) {
      // We've never seen this user — ignore (per slackbot-design.md §14.9).
      return;
    }

    await ctx.db.patch(row._id, {
      username: u.name ?? row.username,
      realName: u.real_name ?? row.realName,
      displayName: u.profile?.display_name ?? row.displayName,
      avatarUrl: u.profile?.image_72 ?? row.avatarUrl,
      timezone: u.tz ?? row.timezone,
      isBot: Boolean(u.is_bot),
      isDeleted: Boolean(u.deleted),
      lastSyncedAt: Date.now(),
    });
    console.log("[Slack:Users] user_change applied", { installationId: args.installationId, slackUserId });
  },
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal helpers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export const _byId = internalQuery({
  args: { id: v.id("slackUsers") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});
```

> **Index requirement:** `handleUserChange` depends on `by_installationId_and_slackUserId`, added in 3A. Do not replace this with `by_slackTeamId_and_slackUserId` for writes; `teamId` alone cannot distinguish dev/prod Slack apps installed into the same workspace.

**Step 2: Verify**

After 3D + 3E are merged + the dev tenant submits a `/qualify-lead`:

```bash
npx convex data slackUsers | head
# One row: lastSyncedAt initially 0, then ~1 second later patched with realName, displayName, avatarUrl.
```

**Key implementation notes:**
- **Keep Slack API actions separate from DB helpers.** `userActions.ts` owns the async HTTP call; `users.ts` stays query/mutation/helper-only. The action should use the default Convex runtime because `fetch()` is available there. Do not use dynamic named imports from `@slack/web-api`; Phase 3 QA reproduced a Convex/esbuild code-splitting failure where `WebClient` resolves incorrectly at runtime.
- **`scheduler.runAfter(0, …)` runs after the surrounding mutation commits.** Because 3D calls `upsertSlackUserOnSubmission(ctx, …)` as a plain helper, the `slackUsers` stub row rolls back with the opportunity if 3D throws. The scheduled `fetchAndSync` is the only work outside the transaction.
- **`fetchAndSync` is best-effort.** Slack rate limits, transient errors, deleted users — all non-fatal. The row stays at `lastSyncedAt: 0` and the next access triggers another attempt.
- **`isBot: false` default in the stub** — if the submitter is somehow a bot (e.g. workflow-builder bot), `applyProfile` corrects it on first sync. The default doesn't affect correctness; UI just shows it as a non-bot until enriched.
- **`crmUserId` is reserved per Open Q2.** Always `undefined` in v1. Keep the schema field — adding it later is more painful than ignoring it now.
- **`displayName ?? realName ?? username ?? slackUserId`** is the recommended display-name fallback in dashboards (per [§6.5](../slackbot-design.md)). Centralize this in a tiny `slackUserDisplay` helper if it's used in 2+ places.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/users.ts` | Create | Query/mutation/helper primitives + `_byId` |
| `convex/slack/userActions.ts` | Create | `fetchAndSync` action |

---

### 3F — Real `rawSlackEvents` Persistence

**Type:** Backend
**Parallelizable:** Yes — runs in parallel with 3D, 3E. Depends on 3A.

**What:** Replace the no-op `persistRawSlackEvent` from Phase 2 2B with a real internal mutation that writes to the `rawSlackEvents` table. Update the helper to call `ctx.runMutation`.

**Why:** Per [§13.7](../slackbot-design.md), every inbound payload must be persisted with redaction. Phase 2 deferred this to land the call sites; Phase 3's schema deploy makes the table available.

**Where:**
- `convex/slack/rawEvents.ts` (new) — internal mutation `insert`
- `convex/slack/rawEventsAudit.ts` (modify — call the real mutation)

**How:**

**Step 1: Implement the mutation**

```typescript
// Path: convex/slack/rawEvents.ts

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const insert = internalMutation({
  args: {
    tenantId: v.optional(v.id("tenants")),
    teamId: v.string(),
    apiAppId: v.optional(v.string()),
    eventType: v.string(),
    payloadRedacted: v.string(),
    requestHash: v.string(),
    slackEventId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Duplicate detection by requestHash — Slack retries on 5xx; we want one row, not N.
    const existing = await ctx.db
      .query("rawSlackEvents")
      .withIndex("by_requestHash", (q) => q.eq("requestHash", args.requestHash))
      .first();
    if (existing) {
      // Already persisted; just return.
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("rawSlackEvents", {
      tenantId: args.tenantId,
      teamId: args.teamId,
      apiAppId: args.apiAppId,
      eventType: args.eventType,
      payloadRedacted: args.payloadRedacted,
      requestHash: args.requestHash,
      slackEventId: args.slackEventId,
      receivedAt: now,
      expiresAt: now + RETENTION_MS,
      // v1 handlers process Slack requests inline; only future async dispatchers
      // or explicit handler failures should write processed: false.
      processed: true,
      processingError: undefined,
    });
  },
});
```

**Step 2: Wire `rawEventsAudit.ts` to the real mutation**

```typescript
// Path: convex/slack/rawEventsAudit.ts (modify the placeholder)

// BEFORE (Phase 2 stub):
export async function persistRawSlackEvent(
  _ctx: ActionCtx,
  args: RawSlackEventInsert,
): Promise<void> {
  const envelope = buildRawEventEnvelope(args);
  console.log("[Slack:Audit] envelope", { ... });
  // Phase 3 will: await ctx.runMutation(internal.slack.rawEvents.insert, envelope);
}

// AFTER:
import { internal } from "../_generated/api";

export async function persistRawSlackEvent(
  ctx: ActionCtx,
  args: RawSlackEventInsert,
): Promise<void> {
  const envelope = buildRawEventEnvelope(args);
  await ctx.runMutation(internal.slack.rawEvents.insert, envelope);
}
```

**Step 3: Add the cleanup cron**

```typescript
// Path: convex/slack/cleanup.ts (modify — add a new cleanup action and helper queries)

// Append to the existing 1G file:

const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const findExpiredRawEvents = internalQuery({
  args: { cutoff: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rawSlackEvents")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.cutoff))
      .take(args.limit);
    return rows.map((r) => r._id);
  },
});

export const deleteRawEventsByIds = internalMutation({
  args: { ids: v.array(v.id("rawSlackEvents")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id);
    }
  },
});

export const deleteExpiredRawEvents = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RAW_EVENT_RETENTION_MS;
    let deleted = 0;
    for (let i = 0; i < 10; i++) {
      const ids = await ctx.runQuery(internal.slack.cleanup.findExpiredRawEvents, {
        cutoff, limit: 200,
      });
      if (ids.length === 0) break;
      await ctx.runMutation(internal.slack.cleanup.deleteRawEventsByIds, { ids });
      deleted += ids.length;
    }
    console.log("[Slack:Cleanup] raw events", { deleted });
    return { deleted };
  },
});
```

**Step 4: Register the cron**

```typescript
// Path: convex/crons.ts (modify — add)

crons.interval(
  "cleanup-slack-raw-events",
  { hours: 24 },
  internal.slack.cleanup.deleteExpiredRawEvents,
  {},
);
```

**Step 5: Verify**

After 2C + 3F are merged and a `/qualify-lead` is run:

```bash
npx convex data rawSlackEvents | head
# Should see one row per slash command + one per submission, with payloadRedacted
# containing redacted strings (no email/phone/response_url visible).

# Verify redaction:
npx convex data rawSlackEvents | jq '.[0].payloadRedacted' | jq .
# Inspect the redacted JSON — confirm no real emails/phones/response_urls.
```

**Key implementation notes:**
- **Audit is awaited.** Phase 2 call sites must not use `void persistRawSlackEvent`; they await this helper so a verified inbound request has a durable audit write before the handler returns. If this threatens the 3-second Slack budget in practice, change the helper internals to `await ctx.scheduler.runAfter(0, internal.slack.rawEvents.insert, envelope)` and keep call sites awaited.
- **Duplicate detection by `requestHash`** prevents Slack-retry duplicates. Slack retries 5xx responses up to 3 times by spec; one row per logical event is what we want.
- **`tenantId` is optional** because some early events (`url_verification` handshake in Phase 6, slash commands from a `team_id` we haven't installed yet) cannot be resolved to a tenant. Audit them anyway — they're useful for diagnostics.
- **Retention 30 days** matches the design's recommendation. Adjustable per tenant compliance requirements; not exposed in v1.
- **`processed: true` is the v1 default** because commands, interactivity, and lifecycle events process inline. Reserve `processed: false` for future async Slack dispatchers or explicit handler failures; otherwise Phase 6 monitoring will produce false positives forever.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/rawEvents.ts` | Create | `insert` mutation |
| `convex/slack/rawEventsAudit.ts` | Modify | Call the real mutation |
| `convex/slack/cleanup.ts` | Modify | Add raw-event cleanup query/mutation/action |
| `convex/crons.ts` | Modify | Register `cleanup-slack-raw-events` (24h) |

---

### 3G — Wire `interactivity` → `createQualifiedLead`

**Type:** Backend
**Parallelizable:** No — must come after 3D + 3E. Tiny, focused PR.

**What:** Replace the "PHASE 3 INSERT POINT" block in `convex/slack/interactivity.ts` (Phase 2 2D) with the actual `internal.slack.createQualifiedLead.create` call. Branch on `{ duplicate: true }` to surface inline errors. Branch on resolver/dedup failures.

**Why:** This is the thread that connects everything. After 3G, the system end-to-end produces a real opportunity row from a `/qualify-lead` submission.

**Where:**
- `convex/slack/interactivity.ts` (modify)

**How:**

**Step 1: Replace the Phase 3 insert point**

```typescript
// Path: convex/slack/interactivity.ts

// At top of file, add:
import { internal } from "../_generated/api";

// Inside the `interactivity` httpAction, locate the comment:
//   // ── 6. PHASE 3 INSERT POINT ───────────────────────────────────────────
// and replace the surrounding block with:

  // ── 6. Phase 3: write the lead/opportunity ─────────────────────────────
  let result: any;
  try {
    result = await ctx.runMutation(internal.slack.createQualifiedLead.create, {
      tenantId: parsed.tenantId,
      installationId: inst._id,
      fullName: parsed.fullName,
      platform: parsed.platform,
      handle: parsed.handle,
      qualifiedBy: {
        slackUserId: parsed.slackUserId,
        slackTeamId: parsed.teamId,
        submittedAt: Date.now(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[Slack:Int] createQualifiedLead threw", { tenantId: parsed.tenantId, err: msg });
    // Surface as inline error on the most user-actionable field.
    return jsonResponse({
      response_action: "errors",
      errors: { handle: "Couldn't save the lead — please try again or contact support." },
    });
  }

  if (result.duplicate) {
    if (result.alreadyBooked) {
      return jsonResponse({
        response_action: "errors",
        errors: { handle: "This lead already has a booked or active opportunity in the CRM." },
      });
    }

    // Format the inline error per slackbot-design.md §14.8.
    const priorAt = result.priorQualifiedBy?.submittedAt;
    const daysAgo = priorAt
      ? Math.max(1, Math.floor((Date.now() - priorAt) / (24 * 60 * 60 * 1000)))
      : null;
    const priorUser = result.priorQualifiedBy?.slackUserId;
    const message = priorUser
      ? `Already qualified by <@${priorUser}>${daysAgo ? ` ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago` : ""}.`
      : "This lead has already been qualified recently.";
    return jsonResponse({
      response_action: "errors",
      errors: { handle: message },
    });
  }

  console.log("[Slack:Int] view_submission committed", {
    tenantId: parsed.tenantId,
    opportunityId: result.opportunityId,
    leadId: result.leadId,
    isNewLead: result.isNewLead,
  });
  return new Response("", { status: 200 });
```

**Step 2: End-to-end verification (manual)**

In the dev workspace:

1. Run `/qualify-lead` and submit Jane Doe / Instagram / @janedoe.
2. Modal closes. Verify in Convex:
   ```bash
   npx convex data opportunities | grep slack_qualified
   # 1 row, status=qualified_pending, qualifiedBy with slackUserId
   npx convex data leads | tail -1
   # 1 new lead, fullName="Jane Doe", email=undefined
   npx convex data leadIdentifiers | grep slack_qualified
   # 1 identifier, type=instagram, source=slack_qualified
   ```
3. Run `/qualify-lead` again with the same handle. Verify the modal stays open with the inline error: "Already qualified by <@U…> 0 days ago."
4. Run `/qualify-lead` with a fresh handle. Verify a fresh opportunity is created (different lead).
5. `npx convex data slackUsers` — verify the row(s) for the test user.
6. `npx convex data rawSlackEvents` — verify per-submission row with redacted payload.
7. `npx convex data domainEvents | grep opportunity.created` — verify the events with `metadata: {"source":"slack_qualified"}`.

**Key implementation notes:**
- **The `try/catch` around `createQualifiedLead.create` is broad on purpose.** Any throw — resolver error, identifier-required-throw, schema constraint — surfaces as a generic "couldn't save" inline error. Specific error messages can grow over time per error class.
- **The duplicate-message format** "Already qualified by <@U…> N days ago" matches §14.8's example. The `<@U…>` syntax is Slack mrkdwn for "ping user" — Slack expands it client-side to the live display name without our needing to look up the slackUsers row.
- **`daysAgo === 0` edge:** "0 days ago" reads weirdly. We omit the duration for sub-day submissions: `Already qualified by <@U…>.` is cleaner. Adjust `daysAgo` to null when sub-24h if product copy prefers.
- **Verify in dev before deploying to prod.** This is the first user-visible Slack-to-CRM write. Once it goes prod, real opportunity rows accumulate and renaming `qualified_pending` becomes a data migration (per Open Q8, decided before 3A merged).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/slack/interactivity.ts` | Modify | Replace "PHASE 3 INSERT POINT" with real mutation call + duplicate handling |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 3A |
| `convex/lib/sideDeals.ts` | Modify | 3B |
| `convex/lib/statusTransitions.ts` | Modify | 3B |
| `convex/lib/tenantStatsHelper.ts` | Modify | 3B |
| Various UI/query files (per audit list) | Modify | 3B + 3C |
| `convex/leads/identityResolution.ts` | Modify | 3C |
| `convex/lib/leadDisplay.ts` | Create | 3C |
| `convex/leads/buildSearchText.ts` (or equivalent) | Modify | 3C |
| `convex/calendly/leadSync.ts` (or equivalent) | Modify | 3C |
| `convex/slack/createQualifiedLead.ts` | Create | 3D |
| `convex/slack/notify.ts` | Create (stub) | 3D |
| `convex/slack/users.ts` | Create | 3E |
| `convex/slack/userActions.ts` | Create | 3E |
| `convex/slack/rawEvents.ts` | Create | 3F |
| `convex/slack/rawEventsAudit.ts` | Modify | 3F |
| `convex/slack/cleanup.ts` | Modify | 3F |
| `convex/crons.ts` | Modify | 3F |
| `convex/slack/interactivity.ts` | Modify | 3G |
