# Phase 1 — Alias Retirement and Canonical Attribution

**Goal:** Remove attribution aliases from the normal product model and make Calendly UTM attribution resolve directly from canonical `attributionTeams` and `dmClosers` rows. After this phase, generated links can map to teams and DM closers without `attributionAliases` or `attributionAliasId` fields.

**Prerequisite:** Pipeline Operations Phase 2 attribution registry is deployed. Before deleting alias schema, production and dev must pass the alias retirement readiness audit with zero alias rows and zero populated `attributionAliasId` values. Read `convex/_generated/ai/guidelines.md` and invoke `convex-migration-helper` if any readiness count is non-zero.

**Runs in PARALLEL with:** Phase 2 can start on new portal tables after 1A confirms whether alias deletion is safe, but Phase 3 and Phase 4 should not ship until this phase compiles and Settings no longer imports alias APIs.

**Skills to invoke:**
- `convex-migration-helper` — Required if aliases or populated alias IDs exist; otherwise document the greenfield single-deploy decision.
- `convex-performance-audit` — Verify the canonical resolver uses bounded, index-backed reads.
- `shadcn` — Remove alias UI while keeping Settings layout consistent with existing cards, tables, alerts, and skeletons.

**Acceptance Criteria:**
1. A system-admin readiness query reports `hasAliasRows: false`, `opportunitiesWithAliasId: 0`, and `meetingsWithAliasId: 0` in production and dev before schema deletion.
2. If any readiness count is non-zero, alias schema and fields remain in place and the implementation switches to a widen-migrate-narrow plan instead of deleting fields.
3. `convex/schema.ts` no longer defines `attributionAliases`, `opportunities.attributionAliasId`, or `meetings.attributionAliasId` when readiness is clean.
4. `convex/lib/attribution/resolveAttribution.ts` exports `ATTRIBUTION_RESOLUTION_VERSION = 2` and resolves canonical team/DM closer matches without alias lookups.
5. Team CRUD rejects `utmSource` values that normalize to `ptdom`.
6. Pipeline and backfill patches no longer write, compare, or return `attributionAliasId`.
7. Settings -> Attribution no longer renders the alias card, `AttributionAliasDialog`, or "create alias" workflows.
8. Recent unmapped UTM review points admins toward canonical team or DM closer creation rather than alias creation.
9. `npx convex dev --once` completes with generated types that do not include `Id<"attributionAliases">`.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (readiness audit) ───────────────┬── clean ──→ 1B (schema removal)
                                    │
                                    └── dirty ──→ migration hold; do not run 1B

1B complete ────────────────────────┬── 1C (canonical resolver v2)
                                    ├── 1D (backend cleanup)
                                    └── 1E (settings UI removal)

1C + 1D + 1E complete ───────────────→ 1F (verification)
```

**Optimal execution:**
1. Run 1A first in both dev and production.
2. If clean, remove schema and generated type references in 1B.
3. Implement resolver, backend cleanup, and UI removal in parallel.
4. Run Convex codegen, TypeScript, and spot-check Settings -> Attribution.

**Estimated time:** 1-2 days when readiness is clean; 3-5 days if migration fallback is needed.

---

## Subphases

### 1A — Alias Readiness Audit

**Type:** Backend / Manual  
**Parallelizable:** No — this determines whether the phase can delete alias schema directly.

**What:** Add a temporary system-admin query that checks for alias table rows and populated alias ID fields, then run it in dev and production before any deletion.

**Why:** Convex schema validation rejects removing fields while documents still contain them. This gate prevents a deploy that would fail or orphan historical attribution.

**Where:**
- `convex/admin/attributionAudit.ts` (create)

**How:**

**Step 1: Create the audit query.**

```typescript
// Path: convex/admin/attributionAudit.ts
import { query } from "../_generated/server";
import { requireSystemAdminSession } from "../requireSystemAdmin";

export const verifyAliasRetirementReadiness = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const aliases = await ctx.db.query("attributionAliases").take(1);
    const opportunities = await ctx.db.query("opportunities").take(500);
    const meetings = await ctx.db.query("meetings").take(500);

    return {
      hasAliasRows: aliases.length > 0,
      opportunitiesWithAliasId: opportunities.filter(
        (row) => row.attributionAliasId !== undefined,
      ).length,
      meetingsWithAliasId: meetings.filter(
        (row) => row.attributionAliasId !== undefined,
      ).length,
    };
  },
});
```

**Step 2: Run and record results.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex run admin/attributionAudit:verifyAliasRetirementReadiness
```

**Step 3: Decide migration path.**

If every count is clean, continue to 1B. If any count is non-zero, stop schema deletion and write a migration issue using the `convex-migration-helper` checklist: keep fields optional, deploy resolver v2 first, backfill rows off aliases, verify, then narrow later.

**Key implementation notes:**
- The audit uses bounded `.take(500)` reads because this project has one test tenant; increase only through a batched migration function if data grows.
- Do not delete `convex/attribution/aliases.ts` before this query has been run.
- Keep the audit query system-admin only.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/admin/attributionAudit.ts` | Create | Temporary readiness query |

---

### 1B — Schema and Type Surface Removal

**Type:** Backend  
**Parallelizable:** No — generated types must stop exposing aliases before callsites can compile cleanly.

**What:** Remove the alias table, alias validator import/export, alias ID fields, and the alias backend module when 1A is clean.

**Why:** Keeping alias schema after the product removes aliases preserves a dead concept and keeps generated types inviting new dependencies.

**Where:**
- `convex/schema.ts` (modify)
- `convex/lib/attribution/validators.ts` (modify)
- `convex/attribution/aliases.ts` (delete)
- `app/workspace/settings/_components/attribution-alias-dialog.tsx` (delete in 1E after imports are removed)

**How:**

**Step 1: Remove alias validators from schema imports.**

```typescript
// Path: convex/schema.ts
import {
  attributionResolutionValidator,
  bookingProgramMappingStatusValidator,
} from "./lib/attribution/validators";
```

**Step 2: Delete the alias table and alias ID fields.**

```typescript
// Path: convex/schema.ts
// Remove the attributionAliases table entirely when readiness is clean.

opportunities: defineTable({
  // Existing fields remain unchanged.
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  attributionResolution: v.optional(attributionResolutionValidator),
  attributionResolvedAt: v.optional(v.number()),
  attributionResolutionVersion: v.optional(v.number()),
});

meetings: defineTable({
  // Existing fields remain unchanged.
  attributionTeamId: v.optional(v.id("attributionTeams")),
  dmCloserId: v.optional(v.id("dmClosers")),
  attributionResolution: v.optional(attributionResolutionValidator),
  attributionResolvedAt: v.optional(v.number()),
  attributionResolutionVersion: v.optional(v.number()),
});
```

**Step 3: Remove `attributionAliasScopeValidator`.**

```typescript
// Path: convex/lib/attribution/validators.ts
import { v } from "convex/values";

export const attributionResolutionValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
  v.literal("internal"),
  v.literal("none"),
);

export const bookingProgramMappingStatusValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
);
```

**Step 4: Regenerate Convex types.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
```

**Key implementation notes:**
- Do not replace alias deletion with nullable alias references. The goal is no alias product surface when readiness is clean.
- If Convex rejects the schema, revert only this subphase and follow the migration fallback from 1A.
- Search generated type errors for `attributionAliases` and fix every caller rather than leaving compatibility shims.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Remove alias table and alias ID fields |
| `convex/lib/attribution/validators.ts` | Modify | Remove alias scope validator |
| `convex/attribution/aliases.ts` | Delete | Remove alias CRUD API |

---

### 1C — Canonical Resolver v2

**Type:** Backend  
**Parallelizable:** Yes — depends on 1B generated types, independent of Settings UI cleanup.

**What:** Rewrite `resolveAttributionForTenant()` to resolve canonical teams and DM closers directly and remove alias-specific return fields.

**Why:** Portal-generated links will only contain canonical `utm_source` and `utm_medium`; the resolver must map them without alias rows.

**Where:**
- `convex/lib/attribution/resolveAttribution.ts` (modify)
- `convex/attribution/teams.ts` (modify)

**How:**

**Step 1: Remove alias IDs from resolver types and patches.**

```typescript
// Path: convex/lib/attribution/resolveAttribution.ts
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { UtmParams } from "../utmParams";
import { normalizeUtmValue } from "./normalize";

type AttributionCtx = QueryCtx | MutationCtx;

export type ResolvedAttribution = {
  resolutionStatus: "mapped" | "unmapped" | "internal" | "none";
  teamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  resolutionVersion: number;
  resolvedAt: number;
};

export const ATTRIBUTION_RESOLUTION_VERSION = 2;

export function attributionPatch(resolved: ResolvedAttribution) {
  return {
    attributionTeamId: resolved.teamId,
    dmCloserId: resolved.dmCloserId,
    attributionResolution: resolved.resolutionStatus,
    attributionResolvedAt: resolved.resolvedAt,
    attributionResolutionVersion: resolved.resolutionVersion,
  };
}
```

**Step 2: Implement canonical resolution order.**

```typescript
// Path: convex/lib/attribution/resolveAttribution.ts
export async function resolveAttributionForTenant(
  ctx: AttributionCtx,
  args: { tenantId: Id<"tenants">; utmParams: UtmParams | undefined },
): Promise<ResolvedAttribution> {
  const resolvedAt = Date.now();
  const source = normalizeUtmValue(args.utmParams?.utm_source);
  const medium = normalizeUtmValue(args.utmParams?.utm_medium);

  if (!source && !medium) {
    return { resolutionStatus: "none", resolutionVersion: 2, resolvedAt };
  }
  if (source === "ptdom") {
    return { resolutionStatus: "internal", resolutionVersion: 2, resolvedAt };
  }

  const team = source
    ? (
        await ctx.db
          .query("attributionTeams")
          .withIndex("by_tenantId_and_normalizedUtmSource", (q) =>
            q.eq("tenantId", args.tenantId).eq("normalizedUtmSource", source),
          )
          .take(5)
      ).find((candidate) => candidate.isActive)
    : null;

  const mediumMatches = medium
    ? (
        await ctx.db
          .query("dmClosers")
          .withIndex("by_tenantId_and_normalizedUtmMedium", (q) =>
            q.eq("tenantId", args.tenantId).eq("normalizedUtmMedium", medium),
          )
          .take(5)
      ).filter((candidate) => candidate.isActive)
    : [];

  const matchingCloser = team
    ? mediumMatches.find((candidate) => candidate.teamId === team._id)
    : mediumMatches.length === 1
      ? mediumMatches[0]
      : null;

  if (team && matchingCloser) {
    return {
      resolutionStatus: "mapped",
      teamId: team._id,
      dmCloserId: matchingCloser._id,
      resolutionVersion: 2,
      resolvedAt,
    };
  }

  if (team) {
    return {
      resolutionStatus: "mapped",
      teamId: team._id,
      resolutionVersion: 2,
      resolvedAt,
    };
  }

  if (matchingCloser) {
    return {
      resolutionStatus: "mapped",
      teamId: matchingCloser.teamId,
      dmCloserId: matchingCloser._id,
      resolutionVersion: 2,
      resolvedAt,
    };
  }

  return { resolutionStatus: "unmapped", resolutionVersion: 2, resolvedAt };
}
```

**Step 3: Reject reserved internal source in team CRUD.**

```typescript
// Path: convex/attribution/teams.ts
const RESERVED_UTM_SOURCE = "ptdom";

function normalizeTeamInput(args: { displayName: string; utmSource: string }) {
  // Existing validation remains.
  const normalizedUtmSource = normalizeUtmValue(utmSource);
  if (normalizedUtmSource === RESERVED_UTM_SOURCE) {
    throw new Error("UTM source ptdom is reserved for internal CRM links.");
  }
  // Return existing normalized payload.
}
```

**Key implementation notes:**
- Pair matching only succeeds when the DM closer belongs to the matched team.
- Medium-only matching is allowed only when exactly one active closer has that normalized medium in the tenant.
- Keep all reads bounded with `.take(5)`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/attribution/resolveAttribution.ts` | Modify | Canonical resolver v2 |
| `convex/attribution/teams.ts` | Modify | Reject reserved `ptdom` source |

---

### 1D — Backend Callsite Cleanup

**Type:** Backend  
**Parallelizable:** Yes — depends on 1B and can run alongside 1E.

**What:** Remove alias comparisons and imports from backfills, pipeline writes, Operations projections, detail payloads, and any generated API references.

**Why:** Schema removal is not complete until no backend code reads or writes deleted fields.

**Where:**
- `convex/attribution/backfills.ts` (modify)
- `convex/pipeline/inviteeCreated.ts` (modify if alias patch appears)
- `convex/lib/attribution/detailPayload.ts` (modify if alias fields appear)
- `convex/operations/*` (modify any alias field references)

**How:**

**Step 1: Remove alias comparisons from backfills.**

```typescript
// Path: convex/attribution/backfills.ts
const changed =
  meeting.bookingProgramId !== patch.bookingProgramId ||
  meeting.bookingProgramName !== patch.bookingProgramName ||
  meeting.bookingProgramMappingStatus !== patch.bookingProgramMappingStatus ||
  meeting.attributionResolution !== patch.attributionResolution ||
  meeting.attributionTeamId !== patch.attributionTeamId ||
  meeting.dmCloserId !== patch.dmCloserId ||
  meeting.soldProgramId !== patch.soldProgramId ||
  meeting.soldProgramName !== patch.soldProgramName;
```

**Step 2: Search and eliminate all alias references.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
rg "attributionAlias|attributionAliases|aliasId|listAliases|createAlias|updateAlias|setAliasActive" convex app
```

**Step 3: Preserve backfill reporting without alias counts.**

```typescript
// Path: convex/attribution/backfills.ts
type BackfillReport = {
  tenantsScanned: number;
  rowsScanned: number;
  rowsChanged: number;
  unmappedCount: number;
  internalCount: number;
  truncatedUtmCount: number;
};
```

**Key implementation notes:**
- Backfills should re-resolve with version 2 but must not rewrite raw `utmParams`.
- If historical rows still have aliases after readiness, stop; this indicates the audit was incomplete.
- Keep rebuilding Operations qualification rows when opportunity attribution changes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/attribution/backfills.ts` | Modify | Remove alias comparison and patch fields |
| `convex/pipeline/inviteeCreated.ts` | Modify | Ensure new writes use canonical patch only |
| `convex/lib/attribution/detailPayload.ts` | Modify | Remove alias details if present |
| `convex/operations/*` | Modify | Remove alias fields from projection payloads if present |

---

### 1E — Settings Alias UI Removal

**Type:** Frontend  
**Parallelizable:** Yes — depends on 1B generated types and can run alongside backend callsite cleanup.

**What:** Remove alias imports, dialog state, alias query/mutation calls, alias card, and alias dialog from Settings -> Attribution.

**Why:** The UI must not offer a retired concept after the schema and backend API disappear.

**Where:**
- `app/workspace/settings/_components/attribution-tab.tsx` (modify)
- `app/workspace/settings/_components/attribution-alias-dialog.tsx` (delete)
- `app/workspace/settings/_components/attribution-unmapped-panel.tsx` (modify)

**How:**

**Step 1: Shrink dialog state to canonical entities.**

```tsx
// Path: app/workspace/settings/_components/attribution-tab.tsx
type DialogState =
  | { kind: "team"; teamId?: Id<"attributionTeams"> }
  | { kind: "dmCloser"; dmCloserId?: Id<"dmClosers"> }
  | null;
```

**Step 2: Remove alias query loading and mutations.**

```tsx
// Path: app/workspace/settings/_components/attribution-tab.tsx
const teams = useQuery(api.attribution.teams.listTeams, {});
const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
const eventTypeConfigs = useQuery(
  api.eventTypeConfigs.queries.listEventTypeConfigs,
  {},
);

if (
  teams === undefined ||
  closers === undefined ||
  eventTypeConfigs === undefined
) {
  return <AttributionTabSkeleton />;
}
```

**Step 3: Replace alias help text in unmapped review.**

```tsx
// Path: app/workspace/settings/_components/attribution-unmapped-panel.tsx
<TableCell colSpan={4} className="text-muted-foreground">
  Create or update a canonical DM team and DM closer to map future bookings.
</TableCell>
```

**Key implementation notes:**
- Delete `AttributionAliasDialog` only after all imports are gone.
- Keep `AttributionTeamsCard`, DM closer management, and booking matrix visible.
- Use existing `Card`, `Table`, `Badge`, and `Skeleton` primitives rather than introducing new layout primitives.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/settings/_components/attribution-tab.tsx` | Modify | Remove alias card and dialog state |
| `app/workspace/settings/_components/attribution-alias-dialog.tsx` | Delete | Retired UI |
| `app/workspace/settings/_components/attribution-unmapped-panel.tsx` | Modify | Canonical repair copy |

---

### 1F — Verification

**Type:** Manual / Backend  
**Parallelizable:** No — runs after cleanup is complete.

**What:** Verify codegen, typecheck, and product behavior for canonical attribution.

**Why:** Alias removal cuts across schema, generated API references, Settings UI, and webhook attribution patches.

**Where:**
- `plans/pipeline-operations-redesign/deferred/phases/phase1.md` (modify if verification notes are added)

**How:**

**Step 1: Run static checks.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Run reference searches.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
rg "attributionAlias|attributionAliases|AttributionAlias|listAliases|createAlias" convex app
```

Expected result: no product code references remain. Historical docs can still mention aliases.

**Step 3: Verify canonical mapping manually.**

Create or use an active team and DM closer, then process a test Calendly payload with matching `utm_source` and `utm_medium`. The resulting meeting and opportunity should have `attributionResolution: "mapped"`, `attributionResolutionVersion: 2`, `attributionTeamId`, and `dmCloserId`.

**Key implementation notes:**
- If Settings imports fail because generated API references still include deleted functions, rerun `npx convex dev --once`.
- Keep the temporary audit query until after production deploy verification, then schedule deletion in a small cleanup PR.
- Do not claim alias data was deleted from raw historical `utmParams`; that data stays immutable.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | Updated by Convex codegen |
| `plans/pipeline-operations-redesign/deferred/phases/phase1.md` | Modify | Optional verification notes |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/admin/attributionAudit.ts` | Create | 1A |
| `convex/schema.ts` | Modify | 1B |
| `convex/lib/attribution/validators.ts` | Modify | 1B |
| `convex/attribution/aliases.ts` | Delete | 1B |
| `convex/lib/attribution/resolveAttribution.ts` | Modify | 1C |
| `convex/attribution/teams.ts` | Modify | 1C |
| `convex/attribution/backfills.ts` | Modify | 1D |
| `convex/pipeline/inviteeCreated.ts` | Modify | 1D |
| `convex/lib/attribution/detailPayload.ts` | Modify | 1D |
| `convex/operations/*` | Modify | 1D |
| `app/workspace/settings/_components/attribution-tab.tsx` | Modify | 1E |
| `app/workspace/settings/_components/attribution-alias-dialog.tsx` | Delete | 1E |
| `app/workspace/settings/_components/attribution-unmapped-panel.tsx` | Modify | 1E |
| `convex/_generated/*` | Generate | 1F |
