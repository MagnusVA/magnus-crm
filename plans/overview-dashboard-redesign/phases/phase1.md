# Phase 1 — Dashboard Query Contract

**Goal:** Build the tenant-scoped Convex overview query contract for the redesigned `/workspace` dashboard. After this phase, the backend returns one typed, range-aware dashboard payload with isolated section result envelopes and no MVP schema changes.

**Prerequisite:** `plans/overview-dashboard-redesign/overview-dashboard-redesign-design.md` is accepted for MVP scope. Existing aggregate tables and indexes are deployed. No schema or data migration is planned for this phase.

**Runs in PARALLEL with:** Phase 2 UI scaffolding after 1A publishes stable DTOs and API names. Final UI query wiring waits for 1E.

**Skills to invoke:**
- `convex` — public query validators, tenant auth, indexed reads, and helper extraction.
- `convex-performance-audit` — keep the composed query bounded, avoid public-query composition, and audit reactive read cost.
- `vercel-react-best-practices` — align the eventual client with one subscription and minimal payload shape.
- `convex-migration-helper` — only if implementation discovers a required new index, rollup table, or backfill; not expected for MVP.

**Acceptance Criteria:**
1. `api.dashboard.overview.getOverviewDashboard` exists and accepts only the Day/Week/Month/Custom range intent defined by this phase.
2. The overview query derives `tenantId` through `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])`; no client argument can select tenant, user, or role.
3. Convex derives and returns the canonical range label, inclusive/exclusive business dates, day count, and `operationsBoundary: "utc_day_key"`.
4. Each dashboard section returns a typed `SectionResult` envelope with `ready`, `empty`, `capped`, or `error` status.
5. Lead Gen and Top Origins reads use existing aggregate tables, indexed `tenantId + dayKey` reads, and explicit caps.
6. Slack qualifier rows preserve the existing `booked / uniqueSlackOpportunityCount` ratio semantics and existing 1000-event truncation behavior.
7. Top DM Closers and Phone Closer Operations read `operationsMeetingDailyStats` through `by_tenantId_and_dayKey`, cap at 1000 source rows, and load only referenced IDs for enrichment.
8. No new table, index, cron, action, external API call, or environment variable is introduced.
9. The implementation does not call public Convex queries through `ctx.runQuery` to compose the dashboard; reusable behavior lives in plain TypeScript helpers.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (contract + range) ─────────────┬── 1B (Lead Gen helper extraction) ─────┐
                                  ├── 1C (Slack breakdown extraction) ─────┤
                                  └── 1D (Operations builders) ────────────┤
                                                                           ├── 1E (composed overview query)
1B also feeds ─────────────────────── 1F (legacy lead-gen query parity) ───┘

1E + 1F complete ───────────────────────────────────────────────────────────── 1G (backend verification)
```

**Optimal execution:**
1. Start 1A first. It defines the DTOs, validators, API name, range helper, and section envelope.
2. Run 1B, 1C, and 1D in parallel because they touch separate source areas and depend only on 1A types.
3. Run 1F alongside 1E once 1B helper exports exist, so existing lead-gen reports keep behavior while the dashboard starts consuming the helpers.
4. Finish with 1G static checks, cap-path checks, and a Convex performance review.

**Estimated time:** 2-4 days

---

## Subphases

### 1A — Overview Contract, Range Resolver, and Public Query Stub

**Type:** Backend
**Parallelizable:** No — this is the contract foundation for every other subphase and Phase 2 UI scaffolding.

**What:** Create the overview DTO types, section envelope type, dashboard range validator, server-side range resolver, and thin public query wrapper.

**Why:** Phase 2 should build against one stable API shape. The range resolver must live server-side so every section uses the same Honduras business-date boundaries and the same UTC day-key operations labels.

**Where:**
- `convex/dashboard/overviewTypes.ts` (new)
- `convex/dashboard/overviewRange.ts` (new)
- `convex/dashboard/overview.ts` (new)

**How:**

**Step 1: Create result and DTO types.**

```typescript
// Path: convex/dashboard/overviewTypes.ts
import type { Id } from "../_generated/dataModel";

export type SectionResult<T> =
  | {
      status: "ready";
      data: T;
      truncated: boolean;
      message: null;
    }
  | {
      status: "empty";
      data: T;
      truncated: false;
      message: string;
    }
  | {
      status: "capped";
      data: null;
      truncated: true;
      message: string;
    }
  | {
      status: "error";
      data: null;
      truncated: false;
      message: string;
    };

export type LeadGenOverview = {
  totalSubmissions: number;
  uniqueProspects: number;
  duplicates: number;
  scheduledHours: number;
  leadsPerHour: number | null;
  topWorkers: Array<{
    workerId: Id<"leadGenWorkers">;
    displayName: string;
    submissions: number;
    uniqueProspects: number;
    leadsPerHour: number | null;
  }>;
};

export type TopQualifierRow = {
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isDeleted: boolean;
  total: number;
  uniqueOpportunityCount: number;
  booked: number;
  ratio: number | null;
};

export type TopDmCloserRow = {
  dmCloserId: Id<"dmClosers">;
  displayName: string;
  teamName: string | null;
  scheduled: number;
  completed: number;
  noShows: number;
  reviewRequired: number;
  showRate: number | null;
};

export type PhoneCloserOperations = {
  rows: Array<{
    closerId: Id<"users">;
    closerName: string;
    scheduled: number;
    completed: number;
    noShows: number;
    reviewRequired: number;
    showRate: number | null;
    noShowRate: number | null;
  }>;
  totals: {
    scheduled: number;
    completed: number;
    noShows: number;
    reviewRequired: number;
    showRate: number | null;
    noShowRate: number | null;
  };
};

export type TopOriginRow = {
  originKey: string;
  source: "instagram" | "meta_business";
  originKind: "post" | "reel" | string;
  originValue: string;
  submissions: number;
  uniqueProspects: number;
};

export type OverviewDashboard = {
  range: PublicOverviewRange;
  leadGen: SectionResult<LeadGenOverview>;
  topQualifiers: SectionResult<{ rows: TopQualifierRow[] }>;
  topDmClosers: SectionResult<{ rows: TopDmCloserRow[] }>;
  phoneCloserOperations: SectionResult<PhoneCloserOperations>;
  topOrigins: SectionResult<{ rows: TopOriginRow[] }>;
};

export type PublicOverviewRange = {
  startBusinessDate: string;
  endBusinessDateInclusive: string;
  endBusinessDateExclusive: string;
  dayCount: number;
  label: string;
  operationsBoundary: "utc_day_key";
};
```

**Step 2: Create the server-side range resolver.**

```typescript
// Path: convex/dashboard/overviewRange.ts
import { v } from "convex/values";
import {
  addBusinessDays,
  businessDateToUtcStart,
  countBusinessDays,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import type { PublicOverviewRange } from "./overviewTypes";

export const MAX_OVERVIEW_CUSTOM_DAYS = 120;

export const overviewRangeValidator = v.union(
  v.object({
    kind: v.literal("preset"),
    preset: v.union(
      v.literal("today"),
      v.literal("this_week"),
      v.literal("this_month"),
    ),
  }),
  v.object({
    kind: v.literal("custom"),
    startBusinessDate: v.string(),
    endBusinessDateInclusive: v.string(),
  }),
);

export type OverviewRangeInput =
  | { kind: "preset"; preset: "today" | "this_week" | "this_month" }
  | {
      kind: "custom";
      startBusinessDate: string;
      endBusinessDateInclusive: string;
    };

export type DerivedOverviewRange = PublicOverviewRange & {
  input: OverviewRangeInput;
  slackWindowStart: number;
  slackWindowEnd: number;
  operationsStartDate: number;
  operationsEndDate: number;
  operationsStartDayKey: string;
  operationsEndDayKeyExclusive: string;
};

export function deriveOverviewRange(
  input: OverviewRangeInput,
  now: number,
): DerivedOverviewRange {
  const today = timestampToBusinessDateKey(now);
  const tomorrow = addBusinessDays(today, 1);
  const startBusinessDate =
    input.kind === "custom"
      ? input.startBusinessDate
      : input.preset === "this_week"
        ? startOfBusinessIsoWeek(today)
        : input.preset === "this_month"
          ? startOfBusinessMonth(today)
          : today;
  const endBusinessDateInclusive =
    input.kind === "custom" ? input.endBusinessDateInclusive : today;
  const endBusinessDateExclusive =
    input.kind === "custom"
      ? addBusinessDays(endBusinessDateInclusive, 1)
      : tomorrow;

  businessDateToUtcStart(startBusinessDate);
  businessDateToUtcStart(endBusinessDateInclusive);
  const dayCount = countBusinessDays(
    startBusinessDate,
    endBusinessDateExclusive,
  );

  if (startBusinessDate > endBusinessDateInclusive) {
    throw new Error("Start date must be on or before end date.");
  }
  if (dayCount > MAX_OVERVIEW_CUSTOM_DAYS) {
    throw new Error(
      `Dashboard range cannot exceed ${MAX_OVERVIEW_CUSTOM_DAYS} days.`,
    );
  }

  const slackWindowStart = businessDateToUtcStart(startBusinessDate);
  const slackWindowEnd = businessDateToUtcStart(endBusinessDateExclusive);

  return {
    input,
    startBusinessDate,
    endBusinessDateInclusive,
    endBusinessDateExclusive,
    slackWindowStart,
    slackWindowEnd,
    operationsStartDate: Date.parse(`${startBusinessDate}T00:00:00.000Z`),
    operationsEndDate: Date.parse(`${endBusinessDateExclusive}T00:00:00.000Z`),
    operationsStartDayKey: startBusinessDate,
    operationsEndDayKeyExclusive: endBusinessDateExclusive,
    dayCount,
    label:
      startBusinessDate === endBusinessDateInclusive
        ? startBusinessDate
        : `${startBusinessDate} to ${endBusinessDateInclusive}`,
    operationsBoundary: "utc_day_key",
  };
}

export function toPublicOverviewRange(
  range: DerivedOverviewRange,
): PublicOverviewRange {
  return {
    startBusinessDate: range.startBusinessDate,
    endBusinessDateInclusive: range.endBusinessDateInclusive,
    endBusinessDateExclusive: range.endBusinessDateExclusive,
    dayCount: range.dayCount,
    label: range.label,
    operationsBoundary: range.operationsBoundary,
  };
}

function startOfBusinessIsoWeek(dateKey: string) {
  businessDateToUtcStart(dateKey);
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const utcDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (utcDay - 1));
  return date.toISOString().slice(0, 10);
}

function startOfBusinessMonth(dateKey: string) {
  businessDateToUtcStart(dateKey);
  return `${dateKey.slice(0, 7)}-01`;
}
```

**Step 3: Add the thin public query wrapper.**

```typescript
// Path: convex/dashboard/overview.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { getOverviewDashboardData } from "./overviewBuilders";
import { overviewRangeValidator } from "./overviewRange";

export const getOverviewDashboard = query({
  args: {
    range: overviewRangeValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await getOverviewDashboardData(ctx, {
      tenantId,
      range: args.range,
      now: Date.now(),
    });
  },
});
```

**Key implementation notes:**
- Keep the query wrapper thin. Auth and argument validation belong here; data assembly belongs in helpers.
- The query is reactive by design because this is the live dashboard. Performance comes from one narrow subscription, not point-in-time reads.
- Do not add `tenantId` or `userId` to `args`. Convex auth is the authority.
- The operations date labels intentionally use UTC day keys because the existing rollup table does.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewTypes.ts` | Create | Public DTO and section result types |
| `convex/dashboard/overviewRange.ts` | Create | Server-side preset/custom range resolver |
| `convex/dashboard/overview.ts` | Create | Thin authenticated public query |

---

### 1B — Lead Gen Dashboard Helpers

**Type:** Backend
**Parallelizable:** Yes — depends on 1A types only and touches Lead Gen files, not Slack or operations builders.

**What:** Extract bounded lead-gen aggregate readers and enrichment helpers so the overview query can reuse proven summary semantics without calling public queries.

**Why:** The dashboard needs the same lead-gen math as existing reports, but public query composition would add overhead and broaden the returned payload. Helper extraction keeps behavior consistent while returning only dashboard fields.

**Where:**
- `convex/leadGen/reportLimits.ts` (new)
- `convex/leadGen/reportReaders.ts` (new)
- `convex/leadGen/reportBuilders.ts` (modify)
- `convex/dashboard/overviewLeadGen.ts` (new)
- `convex/dashboard/overviewOrigins.ts` (new)

**How:**

**Step 1: Centralize lead-gen caps.**

```typescript
// Path: convex/leadGen/reportLimits.ts
export const DAILY_STATS_READ_LIMIT = 500;
export const ORIGIN_STATS_READ_LIMIT = 500;
export const MAX_REPORT_DAYS = 120;
export const TOP_OVERVIEW_WORKER_LIMIT = 5;
export const TOP_OVERVIEW_ORIGIN_LIMIT = 10;
```

**Step 2: Extract reusable bounded readers.**

```typescript
// Path: convex/leadGen/reportReaders.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getSharedDmTeam, type LeadGenTeamId } from "./sharedTeams";
import { DAILY_STATS_READ_LIMIT, ORIGIN_STATS_READ_LIMIT } from "./reportLimits";

type DailyStatsRow = Doc<"leadGenDailyStats">;
type OriginStatsRow = Doc<"leadGenOriginStats">;

export async function readLeadGenDailyRowsForDashboard(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    limit?: number;
  },
): Promise<DailyStatsRow[]> {
  const limit = args.limit ?? DAILY_STATS_READ_LIMIT;
  const rows = await ctx.db
    .query("leadGenDailyStats")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("dayKey", args.startDayKey)
        .lte("dayKey", args.endDayKey),
    )
    .take(limit + 1);

  if (rows.length > limit) {
    throw new Error("Lead Gen range is too large. Narrow the date range.");
  }

  return rows;
}

export async function readLeadGenOriginRowsForDashboard(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDayKey: string;
    endDayKey: string;
    limit?: number;
  },
): Promise<OriginStatsRow[]> {
  const limit = args.limit ?? ORIGIN_STATS_READ_LIMIT;
  const rows = await ctx.db
    .query("leadGenOriginStats")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("dayKey", args.startDayKey)
        .lte("dayKey", args.endDayKey),
    )
    .take(limit + 1);

  if (rows.length > limit) {
    throw new Error("Top posts range is too large. Narrow the date range.");
  }

  return rows;
}

export async function loadLeadGenWorkersForRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Pick<DailyStatsRow, "workerId">[],
) {
  const workerIds = [...new Set(rows.map((row) => row.workerId))];
  const workers = new Map<Id<"leadGenWorkers">, Doc<"leadGenWorkers">>();

  for (const workerId of workerIds) {
    const worker = await ctx.db.get(workerId);
    if (worker && worker.tenantId === tenantId) {
      workers.set(worker._id, worker);
    }
  }

  return workers;
}

export async function loadLeadGenTeamsForRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Pick<DailyStatsRow, "teamId">[],
) {
  const teamIds = [
    ...new Set(
      rows
        .map((row) => row.teamId)
        .filter((teamId): teamId is LeadGenTeamId => teamId !== undefined),
    ),
  ];
  const teams = new Map<LeadGenTeamId, Awaited<ReturnType<typeof getSharedDmTeam>>>();

  for (const teamId of teamIds) {
    const team = await getSharedDmTeam(ctx, { tenantId, teamId });
    if (team) {
      teams.set(team._id, team);
    }
  }

  return teams;
}
```

**Step 3: Add dashboard-specific lead-gen section builders.**

```typescript
// Path: convex/dashboard/overviewLeadGen.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  buildWorkerPerformanceRows,
  summarizeDailyRows,
} from "../leadGen/reportBuilders";
import {
  loadLeadGenTeamsForRows,
  loadLeadGenWorkersForRows,
  readLeadGenDailyRowsForDashboard,
} from "../leadGen/reportReaders";
import { TOP_OVERVIEW_WORKER_LIMIT } from "../leadGen/reportLimits";
import { loadCurrentScheduledHoursByWorkerDay } from "../leadGen/schedules";
import type { DerivedOverviewRange } from "./overviewRange";
import type { LeadGenOverview } from "./overviewTypes";

export async function getLeadGenOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
): Promise<{ data: LeadGenOverview; isEmpty: boolean }> {
  const rows = await readLeadGenDailyRowsForDashboard(ctx, {
    tenantId,
    startDayKey: range.startBusinessDate,
    endDayKey: range.endBusinessDateInclusive,
  });
  const currentScheduledHoursByWorkerDay =
    await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });
  const workers = await loadLeadGenWorkersForRows(ctx, tenantId, rows);
  const teams = await loadLeadGenTeamsForRows(ctx, tenantId, rows);
  const summary = summarizeDailyRows(rows, currentScheduledHoursByWorkerDay);
  const topWorkers = buildWorkerPerformanceRows({
    rows,
    currentScheduledHoursByWorkerDay,
    workers,
    teams,
  })
    .slice(0, TOP_OVERVIEW_WORKER_LIMIT)
    .map((worker) => ({
      workerId: worker.workerId,
      displayName: worker.displayName,
      submissions: worker.submissions,
      uniqueProspects: worker.uniqueProspects,
      leadsPerHour: worker.leadsPerHour,
    }));

  return {
    data: {
      totalSubmissions: summary.submissions,
      uniqueProspects: summary.uniqueProspects,
      duplicates: summary.duplicates,
      scheduledHours: summary.scheduledHours,
      leadsPerHour: summary.leadsPerHour,
      topWorkers,
    },
    isEmpty: summary.submissions === 0,
  };
}
```

**Step 4: Add a dashboard-specific top-origin grouping that ranks by submissions.**

```typescript
// Path: convex/dashboard/overviewOrigins.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { readLeadGenOriginRowsForDashboard } from "../leadGen/reportReaders";
import { TOP_OVERVIEW_ORIGIN_LIMIT } from "../leadGen/reportLimits";
import type { DerivedOverviewRange } from "./overviewRange";
import type { TopOriginRow } from "./overviewTypes";

type OriginStatsRow = Doc<"leadGenOriginStats">;

function isRankableOriginKind(
  originKind: OriginStatsRow["originKind"],
): originKind is "post" | "reel" {
  return originKind === "post" || originKind === "reel";
}

function groupByOrigin(rows: OriginStatsRow[]): TopOriginRow[] {
  const byOrigin = new Map<string, TopOriginRow>();

  for (const row of rows) {
    if (!isRankableOriginKind(row.originKind)) continue;
    const key = `${row.source}:${row.originKey}`;
    const current =
      byOrigin.get(key) ??
      {
        originKey: row.originKey,
        source: row.source,
        originKind: row.originKind,
        originValue: row.originValue,
        submissions: 0,
        uniqueProspects: 0,
      };

    current.submissions += row.submissions;
    current.uniqueProspects += row.uniqueProspectsSubmitted;
    byOrigin.set(key, current);
  }

  return [...byOrigin.values()]
    .sort(
      (left, right) =>
        right.submissions - left.submissions ||
        right.uniqueProspects - left.uniqueProspects ||
        left.originValue.localeCompare(right.originValue),
    )
    .slice(0, TOP_OVERVIEW_ORIGIN_LIMIT);
}

export async function getTopOriginsOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await readLeadGenOriginRowsForDashboard(ctx, {
    tenantId,
    startDayKey: range.startBusinessDate,
    endDayKey: range.endBusinessDateInclusive,
  });
  const origins = groupByOrigin(rows);

  return {
    data: { rows: origins },
    isEmpty: origins.length === 0,
  };
}
```

**Key implementation notes:**
- Existing public lead-gen queries should be modified to import shared caps/readers where practical, but do not change their output shape in this phase.
- Top Origins for this dashboard must rank by `submissions`, not the Excel helper's unique-prospect-first sort.
- Loading workers and teams with `ctx.db.get` is bounded by source rows and only for IDs present in the capped aggregate rows.
- If TypeScript dislikes the `Awaited<ReturnType<typeof getSharedDmTeam>>` map type, replace it with the existing exported `SharedDmTeam` type from `leadGen/sharedTeams`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/reportLimits.ts` | Create | Shared lead-gen caps |
| `convex/leadGen/reportReaders.ts` | Create | Bounded aggregate readers and enrichment helpers |
| `convex/leadGen/reportBuilders.ts` | Modify | Reuse or export builder types needed by dashboard |
| `convex/dashboard/overviewLeadGen.ts` | Create | Lead Gen mini-dashboard section |
| `convex/dashboard/overviewOrigins.ts` | Create | Top posts/reels section |

---

### 1C — Slack Qualifier Breakdown Helper

**Type:** Backend
**Parallelizable:** Yes — depends on 1A DTOs only and touches Slack/reporting files, not Lead Gen or operations.

**What:** Move per-Slack-user row construction into a plain helper that can be used by both `slack.metrics.perSlackUserBreakdown` and the overview query.

**Why:** The dashboard must preserve existing Slack qualification semantics without calling a public query from another query. A shared helper keeps the ratio definition consistent and allows the dashboard to request only five rows.

**Where:**
- `convex/reporting/lib/slackQualificationBreakdown.ts` (new)
- `convex/slack/metrics.ts` (modify)
- `convex/dashboard/overviewSlack.ts` (new)

**How:**

**Step 1: Create the shared per-user breakdown helper.**

```typescript
// Path: convex/reporting/lib/slackQualificationBreakdown.ts
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  listQualificationEventsForRange,
  loadOpportunityMapForQualificationEvents,
  summarizeQualificationEvents,
} from "./slackQualificationLedger";

export type SlackUserQualificationBreakdownRow = {
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isDeleted: boolean;
  total: number;
  qualificationEventCount: number;
  uniqueOpportunityCount: number;
  booked: number;
  ratio: number | null;
};

export async function buildSlackUserQualificationBreakdown(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    windowStart: number;
    windowEnd: number;
    limit: number;
  },
) {
  const events = await listQualificationEventsForRange(ctx, {
    tenantId: args.tenantId,
    start: args.windowStart,
    end: args.windowEnd,
  });
  const opportunityById = await loadOpportunityMapForQualificationEvents(
    ctx,
    events.rows,
  );
  const eventsBySlackUserId = new Map<string, typeof events.rows>();

  for (const event of events.rows) {
    const current = eventsBySlackUserId.get(event.slackUserId) ?? [];
    current.push(event);
    eventsBySlackUserId.set(event.slackUserId, current);
  }

  const rows: SlackUserQualificationBreakdownRow[] = [];
  for (const [slackUserId, userEvents] of eventsBySlackUserId) {
    const summary = summarizeQualificationEvents(userEvents, opportunityById);
    const uniqueSlackOpportunities = getUniqueSlackOpportunities(
      userEvents,
      opportunityById,
    );
    const booked = uniqueSlackOpportunities.filter(
      (opportunity) => opportunity.latestMeetingId !== undefined,
    ).length;
    const user = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", args.tenantId).eq("slackUserId", slackUserId),
      )
      .unique();

    rows.push({
      slackUserId,
      displayName:
        user?.displayName ?? user?.realName ?? user?.username ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      isDeleted: user?.isDeleted ?? false,
      total: summary.qualificationEventCount,
      qualificationEventCount: summary.qualificationEventCount,
      uniqueOpportunityCount: summary.uniqueSlackOpportunityCount,
      booked,
      ratio:
        summary.uniqueSlackOpportunityCount === 0
          ? null
          : booked / summary.uniqueSlackOpportunityCount,
    });
  }

  return {
    rows: rows
      .sort((left, right) => right.total - left.total || right.booked - left.booked)
      .slice(0, args.limit),
    truncated: events.truncated,
  };
}

function getUniqueSlackOpportunities(
  rows: Array<{ opportunityId?: Id<"opportunities"> }>,
  opportunityById: ReadonlyMap<
    Id<"opportunities">,
    Pick<Doc<"opportunities">, "_id" | "source" | "latestMeetingId" | "status">
  >,
) {
  const opportunityIds = [
    ...new Set(
      rows
        .map((row) => row.opportunityId)
        .filter((id): id is Id<"opportunities"> => id !== undefined),
    ),
  ];

  return opportunityIds
    .map((opportunityId) => opportunityById.get(opportunityId))
    .filter((opportunity): opportunity is NonNullable<typeof opportunity> =>
      Boolean(opportunity && opportunity.source === "slack_qualified"),
    );
}
```

**Step 2: Modify the existing Slack public query to delegate to the helper.**

```typescript
// Path: convex/slack/metrics.ts
import { buildSlackUserQualificationBreakdown } from "../reporting/lib/slackQualificationBreakdown";

export const perSlackUserBreakdown = query({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await buildSlackUserQualificationBreakdown(ctx, {
      tenantId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      limit: 25,
    });
  },
});
```

**Step 3: Create the dashboard wrapper with a smaller limit.**

```typescript
// Path: convex/dashboard/overviewSlack.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildSlackUserQualificationBreakdown } from "../reporting/lib/slackQualificationBreakdown";
import type { DerivedOverviewRange } from "./overviewRange";

export async function getTopQualifiersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const breakdown = await buildSlackUserQualificationBreakdown(ctx, {
    tenantId,
    windowStart: range.slackWindowStart,
    windowEnd: range.slackWindowEnd,
    limit: 5,
  });

  return {
    data: {
      rows: breakdown.rows.map((row) => ({
        slackUserId: row.slackUserId,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        isDeleted: row.isDeleted,
        total: row.total,
        uniqueOpportunityCount: row.uniqueOpportunityCount,
        booked: row.booked,
        ratio: row.ratio,
      })),
    },
    truncated: breakdown.truncated,
    isEmpty: breakdown.rows.length === 0,
  };
}
```

**Key implementation notes:**
- Slack truncation is not a hard capped section. It returns partial rows with `truncated: true`.
- Keep `perPlatformConversion` and `conversionMetrics` unchanged unless TypeScript imports can be simplified safely.
- The helper uses indexed Slack user lookup per unique Slack user in a capped event set. Do not add a new index for MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/slackQualificationBreakdown.ts` | Create | Shared per-user Slack qualification builder |
| `convex/slack/metrics.ts` | Modify | Delegate `perSlackUserBreakdown` to helper |
| `convex/dashboard/overviewSlack.ts` | Create | Top qualifiers dashboard section |

---

### 1D — Operations Builders for Phone Closers and DM Closers

**Type:** Backend
**Parallelizable:** Yes — depends on 1A range types only and touches dashboard operations files, not Lead Gen or Slack.

**What:** Build bounded operations helpers from `operationsMeetingDailyStats` for Top DM Closers and Phone Closer Operations.

**Why:** The dashboard needs minimal operations data without the team report's active-closer scan or revenue/report-only columns. These helpers keep reads capped and enrich only referenced IDs.

**Where:**
- `convex/dashboard/overviewOperations.ts` (new)

**How:**

**Step 1: Add the shared operations row reader.**

```typescript
// Path: convex/dashboard/overviewOperations.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { DerivedOverviewRange } from "./overviewRange";

const OPERATIONS_STATS_ROW_LIMIT = 1000;

type OperationsStatsRow = Doc<"operationsMeetingDailyStats">;
type OperationsTotals = {
  scheduled: number;
  completed: number;
  noShows: number;
  reviewRequired: number;
};

function emptyTotals(): OperationsTotals {
  return {
    scheduled: 0,
    completed: 0,
    noShows: 0,
    reviewRequired: 0,
  };
}

function addOperationRow(totals: OperationsTotals, row: OperationsStatsRow) {
  totals.scheduled += row.count;
  if (row.meetingStatus === "completed") totals.completed += row.count;
  if (row.meetingStatus === "no_show") totals.noShows += row.count;
  if (row.meetingStatus === "meeting_overran") {
    totals.reviewRequired += row.count;
  }
}

async function readOperationsStatsRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await ctx.db
    .query("operationsMeetingDailyStats")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", tenantId)
        .gte("dayKey", range.operationsStartDayKey)
        .lt("dayKey", range.operationsEndDayKeyExclusive),
    )
    .take(OPERATIONS_STATS_ROW_LIMIT + 1);

  if (rows.length > OPERATIONS_STATS_ROW_LIMIT) {
    throw new Error("Operations range is too large. Narrow the date range.");
  }

  return rows;
}
```

**Step 2: Add Top DM Closers builder.**

```typescript
// Path: convex/dashboard/overviewOperations.ts
export async function getTopDmClosersOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await readOperationsStatsRows(ctx, tenantId, range);
  const byDmCloser = new Map<Id<"dmClosers">, OperationsTotals>();

  for (const row of rows) {
    if (!row.dmCloserId) continue;
    const current = byDmCloser.get(row.dmCloserId) ?? emptyTotals();
    addOperationRow(current, row);
    byDmCloser.set(row.dmCloserId, current);
  }

  const enriched = [];
  for (const [dmCloserId, totals] of byDmCloser) {
    const dmCloser = await ctx.db.get(dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) continue;
    const team = await ctx.db.get(dmCloser.teamId);

    enriched.push({
      dmCloserId,
      displayName: dmCloser.displayName,
      teamName: team && team.tenantId === tenantId ? team.name : null,
      ...totals,
      showRate:
        totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
    });
  }

  const sortedRows = enriched
    .sort(
      (left, right) =>
        right.scheduled - left.scheduled ||
        right.completed - left.completed ||
        left.displayName.localeCompare(right.displayName),
    )
    .slice(0, 5);

  return {
    data: { rows: sortedRows },
    isEmpty: sortedRows.length === 0,
  };
}
```

**Step 3: Add Phone Closer Operations builder.**

```typescript
// Path: convex/dashboard/overviewOperations.ts
export async function getPhoneCloserOperationsOverviewSection(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  range: DerivedOverviewRange,
) {
  const rows = await readOperationsStatsRows(ctx, tenantId, range);
  const byCloser = new Map<Id<"users">, OperationsTotals>();

  for (const row of rows) {
    const current = byCloser.get(row.assignedCloserId) ?? emptyTotals();
    addOperationRow(current, row);
    byCloser.set(row.assignedCloserId, current);
  }

  const tableRows = [];
  for (const [closerId, totals] of byCloser) {
    const closer = await ctx.db.get(closerId);
    const closerName =
      closer && closer.tenantId === tenantId
        ? closer.fullName ?? closer.email
        : "Removed closer";

    tableRows.push({
      closerId,
      closerName,
      ...totals,
      showRate:
        totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
      noShowRate:
        totals.scheduled === 0 ? null : totals.noShows / totals.scheduled,
    });
  }

  const sortedRows = tableRows.sort(
    (left, right) =>
      right.scheduled - left.scheduled ||
      left.closerName.localeCompare(right.closerName),
  );
  const totals = sortedRows.reduce(
    (acc, row) => ({
      scheduled: acc.scheduled + row.scheduled,
      completed: acc.completed + row.completed,
      noShows: acc.noShows + row.noShows,
      reviewRequired: acc.reviewRequired + row.reviewRequired,
    }),
    emptyTotals(),
  );

  return {
    data: {
      rows: sortedRows,
      totals: {
        ...totals,
        showRate:
          totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
        noShowRate:
          totals.scheduled === 0 ? null : totals.noShows / totals.scheduled,
      },
    },
    isEmpty: sortedRows.length === 0,
  };
}
```

**Key implementation notes:**
- Both operations sections can initially read the same capped source rows separately. If Convex insights or manual query timing show this is too costly, move the read up into `getOverviewDashboardData` and pass the rows into both builders.
- Do not reuse `getActiveClosers()` for this dashboard query. It scans active users that may have no relevant rows.
- Preserve historical rows with fallback names instead of dropping removed phone closers.
- The DM closer builder should skip deleted/mismatched DM closer IDs after tenant verification.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewOperations.ts` | Create | Operations row reader, Top DM Closers, and Phone Closer Operations |

---

### 1E — Compose the Overview Query and Section Envelopes

**Type:** Backend
**Parallelizable:** Yes — can start after 1A and finish after 1B, 1C, and 1D exports are available.

**What:** Implement `getOverviewDashboardData()` and section envelope conversion.

**Why:** One composed public query gives Phase 2 a simple contract and reduces the current dashboard's multiple live subscriptions. Section envelopes allow expected caps or empty states to degrade one widget without blanking the entire dashboard payload.

**Where:**
- `convex/dashboard/overviewBuilders.ts` (new)

**How:**

**Step 1: Add section envelope helpers.**

```typescript
// Path: convex/dashboard/overviewBuilders.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getLeadGenOverviewSection } from "./overviewLeadGen";
import { getTopOriginsOverviewSection } from "./overviewOrigins";
import {
  getPhoneCloserOperationsOverviewSection,
  getTopDmClosersOverviewSection,
} from "./overviewOperations";
import { getTopQualifiersOverviewSection } from "./overviewSlack";
import {
  deriveOverviewRange,
  toPublicOverviewRange,
  type OverviewRangeInput,
} from "./overviewRange";
import type { OverviewDashboard, SectionResult } from "./overviewTypes";

type SectionBuildResult<T> = {
  data: T;
  truncated?: boolean;
  isEmpty?: boolean;
};

async function resolveSection<T>(
  key: string,
  build: () => Promise<SectionBuildResult<T>>,
): Promise<SectionResult<T>> {
  try {
    const result = await build();
    if (result.isEmpty) {
      return {
        status: "empty",
        data: result.data,
        truncated: false,
        message: "No activity for this range.",
      };
    }

    return {
      status: "ready",
      data: result.data,
      truncated: Boolean(result.truncated),
      message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (isExpectedRangeCapError(message)) {
      return {
        status: "capped",
        data: null,
        truncated: true,
        message,
      };
    }

    console.error("[Dashboard:Overview] section failed", { key, message });
    return {
      status: "error",
      data: null,
      truncated: false,
      message: "This section could not be loaded.",
    };
  }
}

function isExpectedRangeCapError(message: string) {
  return /too large|cannot exceed|narrow/i.test(message);
}
```

**Step 2: Compose independent sections with `Promise.all`.**

```typescript
// Path: convex/dashboard/overviewBuilders.ts
export async function getOverviewDashboardData(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    range: OverviewRangeInput;
    now: number;
  },
): Promise<OverviewDashboard> {
  const range = deriveOverviewRange(args.range, args.now);

  const [
    leadGen,
    topQualifiers,
    topDmClosers,
    phoneCloserOperations,
    topOrigins,
  ] = await Promise.all([
    resolveSection("leadGen", () =>
      getLeadGenOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("topQualifiers", () =>
      getTopQualifiersOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("topDmClosers", () =>
      getTopDmClosersOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("phoneCloserOperations", () =>
      getPhoneCloserOperationsOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("topOrigins", () =>
      getTopOriginsOverviewSection(ctx, args.tenantId, range),
    ),
  ]);

  return {
    range: toPublicOverviewRange(range),
    leadGen,
    topQualifiers,
    topDmClosers,
    phoneCloserOperations,
    topOrigins,
  };
}
```

**Key implementation notes:**
- `Promise.all` expresses independence between sections. If one section returns a capped envelope, it does not prevent other sections from resolving.
- Section envelopes catch expected cap and section-level data failures. They cannot catch transaction-size failures for the whole composed query; Phase 3 verifies whether splitting into per-section queries is needed.
- Console errors use the `[Dashboard:Overview]` tag and do not log tenant data or raw events.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/dashboard/overviewBuilders.ts` | Create | Section envelope resolution and composed payload |

---

### 1F — Preserve Existing Lead Gen Report Behavior

**Type:** Backend
**Parallelizable:** Yes — depends on 1B helper exports and can run while 1E composes dashboard sections.

**What:** Update existing lead-gen public report queries to consume extracted helpers where appropriate without changing their API shape.

**Why:** Helper extraction should not fork behavior or silently break `/workspace/lead-gen` reports. Existing screens must keep their current results while the overview query reuses the same core logic.

**Where:**
- `convex/leadGen/reporting.ts` (modify)
- `convex/leadGen/reportBuilders.ts` (modify only if exported types/functions are needed)

**How:**

**Step 1: Replace local constants with shared limits.**

```typescript
// Path: convex/leadGen/reporting.ts
import {
  DAILY_STATS_READ_LIMIT,
  MAX_REPORT_DAYS,
  ORIGIN_STATS_READ_LIMIT,
} from "./reportLimits";
```

**Step 2: Use shared builders where the output already matches.**

```typescript
// Path: convex/leadGen/reporting.ts
import {
  buildWorkerPerformanceRows,
  summarizeDailyRows,
} from "./reportBuilders";

export const getOverview = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
      tenantId,
      ...args,
      limit: DAILY_STATS_READ_LIMIT,
    });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });

    return summarizeDailyRows(rows, currentScheduledHoursByWorkerDay);
  },
});
```

**Step 3: Keep public output compatibility explicit.**

```typescript
// Path: convex/leadGen/reporting.ts
export const listWorkerPerformance = query({
  args: reportFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateDayRange(args);
    await validateFilterIds(ctx, { tenantId, ...args });
    const rows = await readDailyStatsRows(ctx, {
      tenantId,
      ...args,
      limit: DAILY_STATS_READ_LIMIT,
    });
    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, { tenantId, rows });
    const workers = await loadWorkers(ctx, tenantId, [
      ...new Set(rows.map((row) => row.workerId)),
    ]);
    const teams = await loadTeams(
      ctx,
      tenantId,
      [
        ...new Set(rows.map((row) => row.teamId)),
      ].filter((teamId): teamId is NonNullable<typeof teamId> => teamId !== undefined),
    );

    return buildWorkerPerformanceRows({
      rows,
      currentScheduledHoursByWorkerDay,
      workers,
      teams,
    }).map((row) => ({
      workerId: row.workerId,
      displayName: row.displayName,
      email: row.email,
      teamId: row.teamId,
      isActive: row.isActive,
      submissions: row.submissions,
      uniqueProspects: row.uniqueProspects,
      duplicates: row.duplicates,
      scheduledHours: row.scheduledHours,
      leadsPerHour: row.leadsPerHour,
    }));
  },
});
```

**Key implementation notes:**
- Do not change public lead-gen query names, args, or return fields in this phase.
- If a helper extraction creates too much churn in `reporting.ts`, keep current public query internals and only export new dashboard readers. Correctness beats deduplication.
- Run a targeted diff on old vs new report return shapes before moving to Phase 2 wiring.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/reporting.ts` | Modify | Import shared caps/builders while preserving public API shape |
| `convex/leadGen/reportBuilders.ts` | Modify | Export any needed helper types or comparison functions |

---

### 1G — Backend Verification and Performance Gate

**Type:** Backend / Manual
**Parallelizable:** No — validates the completed Phase 1 contract.

**What:** Run static checks, inspect generated API references, verify bounded reads, and record cap/truncation behavior for known ranges.

**Why:** Phase 2 should not start final wiring until the backend contract is stable and TypeScript-visible. This gate catches missing generated references, accidental unbounded reads, and public-query composition before UI work depends on them.

**Where:**
- `plans/overview-dashboard-redesign/phases/phase1.md` (modify if findings require plan correction)
- No production source file should be modified unless verification finds a defect.

**How:**

**Step 1: Generate Convex types and run TypeScript.**

```bash
# Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Search for forbidden patterns in new dashboard code.**

```bash
# Path: terminal
rg -n "ctx\\.runQuery|\\.collect\\(|\\.filter\\(\\(?q" convex/dashboard convex/leadGen convex/slack
rg -n "tenantId: v\\.id\\(\"tenants\"\\)|userId: v\\.id\\(\"users\"\\)" convex/dashboard
```

**Step 3: Check source-row caps are explicit.**

```bash
# Path: terminal
rg -n "take\\(.+\\+ 1\\)|OPERATIONS_STATS_ROW_LIMIT|DAILY_STATS_READ_LIMIT|ORIGIN_STATS_READ_LIMIT|MAX_QUALIFICATION_EVENTS" convex/dashboard convex/leadGen convex/reporting/lib
```

**Step 4: If a connected deployment is available, inspect runtime signals.**

```bash
# Path: terminal
npx convex insights --details
npx convex logs --history 100
```

**Key implementation notes:**
- If `npx convex insights --details` is unavailable because of CLI version, try `npx -y convex@latest insights --details`.
- If any MVP range commonly caps because operations rows exceed 1000, do not add a rollup table inside Phase 1. Capture it as a follow-up migration using `convex-migration-helper`.
- The expected Phase 1 end state is a compiled backend contract, not final UI behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase1.md` | Modify | Only if verification findings change the plan |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/dashboard/overviewTypes.ts` | Create | 1A |
| `convex/dashboard/overviewRange.ts` | Create | 1A |
| `convex/dashboard/overview.ts` | Create | 1A |
| `convex/leadGen/reportLimits.ts` | Create | 1B |
| `convex/leadGen/reportReaders.ts` | Create | 1B |
| `convex/leadGen/reportBuilders.ts` | Modify | 1B, 1F |
| `convex/dashboard/overviewLeadGen.ts` | Create | 1B |
| `convex/dashboard/overviewOrigins.ts` | Create | 1B |
| `convex/reporting/lib/slackQualificationBreakdown.ts` | Create | 1C |
| `convex/slack/metrics.ts` | Modify | 1C |
| `convex/dashboard/overviewSlack.ts` | Create | 1C |
| `convex/dashboard/overviewOperations.ts` | Create | 1D |
| `convex/dashboard/overviewBuilders.ts` | Create | 1E |
| `convex/leadGen/reporting.ts` | Modify | 1F |
