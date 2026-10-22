import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  countCloserPipelineByStage,
  countCloserPipelineByStatus,
  countStripByStage,
  countStripByStatus,
  readCloserMeetingDeals,
} from "../closer/dashboard";
import { assertValidDateRange } from "../reporting/lib/helpers";
import { isPersonLoss } from "../reporting/lib/outcomeDerivation";
import {
  addReadMeter,
  meterDocument,
  meterRange,
  newReadMeter,
  type ReadMeter,
} from "../reporting/lib/readMeter";
import {
  ACTIVE_PIPELINE_STATUSES,
  OPEN_PIPELINE_STAGES,
  countLossesByActor,
  readLossesByStage,
  readLossesByStatus,
  readPipelineDistributionByStage,
  readPipelineDistributionByStatus,
  readPipelineVelocityByStage,
  readPipelineVelocityByStatus,
  scanPipelineAgingByStage,
  scanPipelineAgingByStatus,
  type ActivePipelineStatus,
  type OpenPipelineStage,
  type PipelineAgingGroup,
  type PipelineLosses,
  type PipelineVelocity,
  type StaleCandidate,
} from "../reporting/pipelineHealth";
import {
  emptyOutcomeCounts,
  meetingOutcomesByStage,
  meetingOutcomesByStatus,
  readTeamOutcomeInputs,
  type OutcomeCounts,
} from "../reporting/teamOutcomes";
import { LEGACY_STATUS_GROUPS, dealPosition, dealStageOf } from "./stages";
import { opportunityStatusValidator } from "./validators";

// The report numbers both ways, for the parity queries in stageParity.ts
// (docs/plans/phase-5-deal-status.md §10.4): each compares the status way a
// screen shows today with the stage way PR 5 or PR 6 moves it to, and returns
// the differences with IDs and counts only, never a name or an email. PR 9
// removes this module with the status ways.
//
// Each query pages with a cursor where production could exceed Convex's
// per-call limits (16 MiB and 32,000 documents read, 4,096 index ranges).
// The cursor carries everything compared so far, so the last page holds the
// whole comparison: run with each `continueCursor` until `isDone`.

// A call stops starting new work (a closer, a window of deals) past these.
// The work it starts last reads on top of them, so they sit well under the
// limits: a window reads at most 2 × WINDOW_DOC_CAP deals, and one closer's
// deals are under 1,000 in production.
const CALL_DOC_BUDGET = 3_000;
const CALL_BYTE_BUDGET = 5 * 1024 * 1024;
const CALL_RANGE_BUDGET = 1_500;
// A deal's size before any has been read (production deals are 1.5 to 2 KB).
const GUESSED_DEAL_BYTES = 2_000;
const MAX_TENANT_USERS = 500;
const MAX_DIFFERENCES = 100;
const MAX_DIFFERENCE_IDS = 20;
const MAX_STALE_ROWS = 20;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const WINDOW_DOC_CAP = 1_000;
const DEFAULT_MEETING_PAGE = 1_000;
const MAX_MEETING_PAGE = 2_000;

// ── Shared ──────────────────────────────────────────────────────────────

const dealPositionValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("won"),
  v.literal("lost"),
);

const positionCountsValidator = v.object({
  qualified: v.number(),
  booked: v.number(),
  call_held: v.number(),
  follow_up: v.number(),
  won: v.number(),
  lost: v.number(),
});

const statusCountsValidator = v.object({
  qualified_pending: v.number(),
  scheduled: v.number(),
  follow_up_scheduled: v.number(),
  reschedule_link_sent: v.number(),
  payment_received: v.number(),
  lost: v.number(),
  canceled: v.number(),
  no_show: v.number(),
});

type PositionCounts = Infer<typeof positionCountsValidator>;
type StatusCounts = Infer<typeof statusCountsValidator>;

function positionGroupDifferences(positions: PositionCounts, statuses: StatusCounts) {
  return LEGACY_STATUS_GROUPS.flatMap((group) => {
    const byStage = group.positions.reduce((sum, position) => sum + positions[position], 0);
    const byStatus = group.statuses.reduce((sum, status) => sum + statuses[status], 0);
    return byStage === byStatus
      ? []
      : [{ positions: group.positions, statuses: group.statuses, byStage, byStatus }];
  });
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a number of at least 1`);
  }
  return Math.floor(value);
}

function overBudget(meter: ReadMeter, docBudget: number): boolean {
  return (
    meter.docs >= docBudget ||
    meter.bytes >= CALL_BYTE_BUDGET ||
    meter.ranges >= CALL_RANGE_BUDGET
  );
}

/** IDs in one list and not the other, a few of them. */
function symmetricDifference<T extends string>(left: T[], right: T[]): T[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [
    ...left.filter((id) => !rightSet.has(id)),
    ...right.filter((id) => !leftSet.has(id)),
  ].slice(0, MAX_DIFFERENCE_IDS);
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && symmetricDifference(left, right).length === 0;
}

function approxEqual(left: number | null, right: number | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

/** Copies a cursor the query was given, to update it. */
function copyCursor<T>(cursor: T): T {
  return JSON.parse(JSON.stringify(cursor)) as T;
}

function appendDifferences<T>(
  state: { differences: T[]; differenceCount: number },
  rows: T[],
): void {
  for (const row of rows) {
    state.differenceCount += 1;
    if (state.differences.length < MAX_DIFFERENCES) {
      state.differences.push(row);
    }
  }
}

/** The tenant's users after a creation time, in creation order. */
async function readTenantUsers(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  afterCreationTime: number | null,
  meter: ReadMeter,
): Promise<Array<Doc<"users">>> {
  const users = await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) =>
      afterCreationTime === null
        ? q.eq("tenantId", tenantId)
        : q.eq("tenantId", tenantId).gt("_creationTime", afterCreationTime),
    )
    .take(MAX_TENANT_USERS);
  meterRange(meter);
  return users;
}

// ── compareStageCounts ──────────────────────────────────────────────────
// The distribution chart and the closer pipeline tabs: each position's count
// in opportunityByStage against its statuses, tenant-wide from
// opportunityByStatus as the chart reads it, and for each closer against the
// scan the tabs read today. Expected: no difference (§7).
//
// Production: the tenant-wide counts are aggregate reads; the closers' scans
// read the ~6,000 deals that have a closer (§2.1), so 2 to 3 calls.

const countDifferenceValidator = v.object({
  // null for the tenant-wide counts.
  closerId: v.union(v.id("users"), v.null()),
  positions: v.array(dealPositionValidator),
  statuses: v.array(opportunityStatusValidator),
  byStage: v.number(),
  byStatus: v.number(),
});

const tenantCountsValidator = v.object({
  positions: positionCountsValidator,
  statuses: statusCountsValidator,
  total: v.object({ byStage: v.number(), byStatus: v.number() }),
});

const closerCountsValidator = v.object({
  closerId: v.id("users"),
  positions: positionCountsValidator,
  statuses: statusCountsValidator,
});

const stageCountsCursorValidator = v.object({
  afterCreationTime: v.union(v.number(), v.null()),
  tenant: tenantCountsValidator,
  closers: v.array(closerCountsValidator),
  differences: v.array(countDifferenceValidator),
  differenceCount: v.number(),
  dealsScanned: v.number(),
  bytesScanned: v.number(),
});

type StageCountsCursor = Infer<typeof stageCountsCursorValidator>;

export const compareStageCountsArgs = {
  tenantId: v.id("tenants"),
  cursor: v.optional(stageCountsCursorValidator),
  // Deals the closers' scans may read in one call before it stops.
  docBudget: v.optional(v.number()),
};

export const compareStageCountsReturns = v.object({
  tenant: tenantCountsValidator,
  closers: v.array(closerCountsValidator),
  differences: v.array(countDifferenceValidator),
  differenceCount: v.number(),
  dealsScanned: v.number(),
  bytesScanned: v.number(),
  ok: v.boolean(),
  isDone: v.boolean(),
  continueCursor: v.union(stageCountsCursorValidator, v.null()),
});

async function initialStageCountsCursor(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): Promise<StageCountsCursor> {
  const [statusRows, positionRows] = await Promise.all([
    readPipelineDistributionByStatus(ctx, tenantId),
    readPipelineDistributionByStage(ctx, tenantId),
  ]);
  const statuses = Object.fromEntries(
    statusRows.map(({ status, count }) => [status, count]),
  ) as StatusCounts;
  const positions = Object.fromEntries(
    positionRows.map(({ position, count }) => [position, count]),
  ) as PositionCounts;
  const cursor: StageCountsCursor = {
    afterCreationTime: null,
    tenant: {
      positions,
      statuses,
      total: {
        byStage: positionRows.reduce((sum, row) => sum + row.count, 0),
        byStatus: statusRows.reduce((sum, row) => sum + row.count, 0),
      },
    },
    closers: [],
    differences: [],
    differenceCount: 0,
    dealsScanned: 0,
    bytesScanned: 0,
  };
  appendDifferences(
    cursor,
    positionGroupDifferences(positions, statuses).map((row) => ({ closerId: null, ...row })),
  );
  return cursor;
}

export async function compareStageCountsPage(
  ctx: QueryCtx,
  args: { tenantId: Id<"tenants">; cursor?: StageCountsCursor; docBudget?: number },
): Promise<Infer<typeof compareStageCountsReturns>> {
  const docBudget = positiveLimit(args.docBudget, CALL_DOC_BUDGET, "docBudget");
  const state = args.cursor
    ? copyCursor(args.cursor)
    : await initialStageCountsCursor(ctx, args.tenantId);
  const meter = newReadMeter();
  const scanMeter = newReadMeter();

  const users = await readTenantUsers(ctx, args.tenantId, state.afterCreationTime, meter);
  let stopped = false;
  for (const user of users) {
    if (user.role === "closer") {
      const byStage = await countCloserPipelineByStage(ctx, args.tenantId, user._id);
      const averageBytes =
        scanMeter.docs > 0 ? scanMeter.bytes / scanMeter.docs : GUESSED_DEAL_BYTES;
      if (
        scanMeter.docs > 0 &&
        (scanMeter.docs + byStage.total > docBudget ||
          scanMeter.bytes + byStage.total * averageBytes > CALL_BYTE_BUDGET)
      ) {
        stopped = true;
        break;
      }
      const byStatus = await countCloserPipelineByStatus(
        ctx,
        args.tenantId,
        user._id,
        scanMeter,
      );
      state.closers.push({
        closerId: user._id,
        positions: byStage.counts,
        statuses: byStatus.counts,
      });
      appendDifferences(
        state,
        positionGroupDifferences(byStage.counts, byStatus.counts).map((row) => ({
          closerId: user._id,
          ...row,
        })),
      );
    }
    state.afterCreationTime = user._creationTime;
  }
  addReadMeter(meter, scanMeter);
  state.dealsScanned += scanMeter.docs;
  state.bytesScanned += scanMeter.bytes;

  const isDone = !stopped && users.length < MAX_TENANT_USERS;
  return {
    tenant: state.tenant,
    closers: state.closers,
    differences: state.differences,
    differenceCount: state.differenceCount,
    dealsScanned: state.dealsScanned,
    bytesScanned: state.bytesScanned,
    ok: state.differenceCount === 0,
    isDone,
    continueCursor: isDone ? null : state,
  };
}

// ── comparePipelineHealth ───────────────────────────────────────────────
// Pipeline Health's aging table, stale list, velocity and loss attribution.
// Expected: no difference; the side deal is Call held in the stage way,
// where the status way counts it under Scheduled, so aging compares
// Scheduled with Booked and Call held together (§7). `aging.scanned.byStage`
// is what the stage-way aging scan reads, the docs and bytes PR 6's screen
// would read in one call.
//
// The aging pages over windows of the deals' creation time, each read both
// ways in the same call; a window holding more than WINDOW_DOC_CAP deals on
// either side is retried smaller. Production: ~4,200 open deals read twice,
// with the 1,230 Qualified deals of the last 30 days split over smaller
// windows, so 3 to 4 calls, then one for velocity and losses: 4 to 5 calls.

const AGING_GROUPS: ReadonlyArray<{
  key: string;
  statuses: ActivePipelineStatus[];
  stages: OpenPipelineStage[];
}> = [
  { key: "qualified", statuses: ["qualified_pending"], stages: ["qualified"] },
  { key: "booked_or_call_held", statuses: ["scheduled"], stages: ["booked", "call_held"] },
  {
    key: "follow_up",
    statuses: ["follow_up_scheduled", "reschedule_link_sent"],
    stages: ["follow_up"],
  },
];

const agingGroupValidator = v.object({
  count: v.number(),
  totalAgeDays: v.number(),
  oldestAgeDays: v.number(),
});

const agingRowValidator = v.object({
  count: v.number(),
  averageAgeDays: v.union(v.number(), v.null()),
  oldestAgeDays: v.union(v.number(), v.null()),
});

const staleRowValidator = v.object({
  opportunityId: v.id("opportunities"),
  ageDays: v.number(),
  nextMeetingAt: v.union(v.number(), v.null()),
});

const scannedValidator = v.object({ docs: v.number(), bytes: v.number() });

const statusAgingValidator = v.object({
  groups: v.object({
    qualified_pending: agingGroupValidator,
    scheduled: agingGroupValidator,
    follow_up_scheduled: agingGroupValidator,
    reschedule_link_sent: agingGroupValidator,
  }),
  staleCount: v.number(),
  staleTop: v.array(staleRowValidator),
  scanned: scannedValidator,
});

const stageAgingValidator = v.object({
  groups: v.object({
    qualified: agingGroupValidator,
    booked: agingGroupValidator,
    call_held: agingGroupValidator,
    follow_up: agingGroupValidator,
  }),
  staleCount: v.number(),
  staleTop: v.array(staleRowValidator),
  scanned: scannedValidator,
});

const healthDifferenceValidator = v.object({
  check: v.string(),
  key: v.string(),
  byStatus: v.union(v.number(), v.null()),
  byStage: v.union(v.number(), v.null()),
  opportunityIds: v.array(v.id("opportunities")),
});

type HealthDifference = Infer<typeof healthDifferenceValidator>;

const healthCursorValidator = v.object({
  // Aging windows until every open deal is read, then velocity and losses.
  phase: v.union(v.literal("aging"), v.literal("rest")),
  // The next window's start, null before the first.
  windowFrom: v.union(v.number(), v.null()),
  windowSize: v.number(),
  windows: v.number(),
  byStatus: statusAgingValidator,
  byStage: stageAgingValidator,
  differences: v.array(healthDifferenceValidator),
  differenceCount: v.number(),
});

type HealthCursor = Infer<typeof healthCursorValidator>;
type StaleRow = Infer<typeof staleRowValidator>;

const velocityRowValidator = v.object({
  velocityDays: v.union(v.number(), v.null()),
  wonCount: v.number(),
  truncated: v.boolean(),
});

const lossRowValidator = v.object({
  count: v.number(),
  unknown: v.number(),
  byActor: v.array(v.object({ userId: v.id("users"), count: v.number() })),
  truncated: v.boolean(),
  scanned: v.number(),
});

export const comparePipelineHealthArgs = {
  tenantId: v.id("tenants"),
  // The loss attribution's range, as the report takes it.
  startDate: v.number(),
  endDate: v.number(),
  cursor: v.optional(healthCursorValidator),
  limits: v.optional(
    v.object({
      // Deals read in one call before it stops starting windows.
      docBudget: v.optional(v.number()),
      // The widest window of creation time.
      windowDays: v.optional(v.number()),
      // Deals a window may hold on either side before it is retried smaller.
      windowDocCap: v.optional(v.number()),
    }),
  ),
};

export const comparePipelineHealthReturns = v.object({
  aging: v.object({
    byStatus: v.object({
      qualified_pending: agingRowValidator,
      scheduled: agingRowValidator,
      follow_up_scheduled: agingRowValidator,
      reschedule_link_sent: agingRowValidator,
    }),
    byStage: v.object({
      qualified: agingRowValidator,
      booked: agingRowValidator,
      call_held: agingRowValidator,
      follow_up: agingRowValidator,
    }),
    staleCount: v.object({ byStatus: v.number(), byStage: v.number() }),
    staleTop: v.object({
      byStatus: v.array(staleRowValidator),
      byStage: v.array(staleRowValidator),
    }),
    scanned: v.object({ byStatus: scannedValidator, byStage: scannedValidator }),
    windows: v.number(),
  }),
  // Set on the last page.
  velocity: v.union(
    v.object({ byStatus: velocityRowValidator, byStage: velocityRowValidator }),
    v.null(),
  ),
  lossAttribution: v.union(
    v.object({ byStatus: lossRowValidator, byStage: lossRowValidator }),
    v.null(),
  ),
  differences: v.array(healthDifferenceValidator),
  differenceCount: v.number(),
  ok: v.boolean(),
  isDone: v.boolean(),
  continueCursor: v.union(healthCursorValidator, v.null()),
});

function emptyAgingGroup(): PipelineAgingGroup {
  return { count: 0, totalAgeDays: 0, oldestAgeDays: 0 };
}

function initialHealthCursor(windowSize: number): HealthCursor {
  return {
    phase: "aging",
    windowFrom: null,
    windowSize,
    windows: 0,
    byStatus: {
      groups: {
        qualified_pending: emptyAgingGroup(),
        scheduled: emptyAgingGroup(),
        follow_up_scheduled: emptyAgingGroup(),
        reschedule_link_sent: emptyAgingGroup(),
      },
      staleCount: 0,
      staleTop: [],
      scanned: { docs: 0, bytes: 0 },
    },
    byStage: {
      groups: {
        qualified: emptyAgingGroup(),
        booked: emptyAgingGroup(),
        call_held: emptyAgingGroup(),
        follow_up: emptyAgingGroup(),
      },
      staleCount: 0,
      staleTop: [],
      scanned: { docs: 0, bytes: 0 },
    },
    differences: [],
    differenceCount: 0,
  };
}

/** The earliest creation time of an open deal, either way, or null. */
async function earliestOpenCreatedAt(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  meter: ReadMeter,
): Promise<number | null> {
  const firsts = await Promise.all([
    ...ACTIVE_PIPELINE_STATUSES.map((status) =>
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("status", status),
        )
        .first(),
    ),
    ...OPEN_PIPELINE_STAGES.map((stage) =>
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("stage", stage).eq("outcome", "open"),
        )
        .first(),
    ),
  ]);
  let earliest: number | null = null;
  for (const deal of firsts) {
    meterRange(meter);
    meterDocument(meter, deal);
    if (deal && (earliest === null || deal.createdAt < earliest)) {
      earliest = deal.createdAt;
    }
  }
  return earliest;
}

function mergeAgingGroup(target: PipelineAgingGroup, source: PipelineAgingGroup): void {
  target.count += source.count;
  target.totalAgeDays += source.totalAgeDays;
  target.oldestAgeDays = Math.max(target.oldestAgeDays, source.oldestAgeDays);
}

/** The oldest stale deals, oldest first, ties by ID so both ways agree. */
function mergeStaleTop(top: StaleRow[], candidates: StaleCandidate[]): StaleRow[] {
  return [
    ...top,
    ...candidates.map(({ opportunity, ageDays, nextMeetingAt }) => ({
      opportunityId: opportunity._id,
      ageDays,
      nextMeetingAt,
    })),
  ]
    .sort(
      (left, right) =>
        right.ageDays - left.ageDays ||
        (left.opportunityId < right.opportunityId ? -1 : left.opportunityId > right.opportunityId ? 1 : 0),
    )
    .slice(0, MAX_STALE_ROWS);
}

/**
 * Reads one window of creation time both ways and adds it to the cursor, or
 * returns false when either side holds more than `cap` deals.
 */
async function compareAgingWindow(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
  state: HealthCursor,
  window: { from: number; to?: number },
  cap: number,
  meter: ReadMeter,
): Promise<boolean> {
  const statusMeter = newReadMeter();
  const statusIds: Record<ActivePipelineStatus, Array<Id<"opportunities">>> = {
    qualified_pending: [],
    scheduled: [],
    follow_up_scheduled: [],
    reschedule_link_sent: [],
  };
  const byStatus = await scanPipelineAgingByStatus(ctx, tenantId, now, {
    createdAt: window,
    maxDocs: cap,
    meter: statusMeter,
    onDeal: (key, deal) => statusIds[key].push(deal._id),
  });
  addReadMeter(meter, statusMeter);
  if (byStatus.capped) {
    return false;
  }

  const stageMeter = newReadMeter();
  const stageIds: Record<OpenPipelineStage, Array<Id<"opportunities">>> = {
    qualified: [],
    booked: [],
    call_held: [],
    follow_up: [],
  };
  const byStage = await scanPipelineAgingByStage(ctx, tenantId, now, {
    createdAt: window,
    maxDocs: cap,
    meter: stageMeter,
    onDeal: (key, deal) => stageIds[key].push(deal._id),
  });
  addReadMeter(meter, stageMeter);
  if (byStage.capped) {
    return false;
  }

  for (const status of ACTIVE_PIPELINE_STATUSES) {
    mergeAgingGroup(state.byStatus.groups[status], byStatus.groups[status]);
  }
  for (const stage of OPEN_PIPELINE_STAGES) {
    mergeAgingGroup(state.byStage.groups[stage], byStage.groups[stage]);
  }
  state.byStatus.staleCount += byStatus.staleCount;
  state.byStage.staleCount += byStage.staleCount;
  state.byStatus.staleTop = mergeStaleTop(state.byStatus.staleTop, byStatus.staleCandidates);
  state.byStage.staleTop = mergeStaleTop(state.byStage.staleTop, byStage.staleCandidates);
  state.byStatus.scanned.docs += statusMeter.docs;
  state.byStatus.scanned.bytes += statusMeter.bytes;
  state.byStage.scanned.docs += stageMeter.docs;
  state.byStage.scanned.bytes += stageMeter.bytes;
  state.windows += 1;

  appendDifferences(
    state,
    AGING_GROUPS.flatMap((group): HealthDifference[] => {
      const statusGroupIds = group.statuses.flatMap((status) => statusIds[status]);
      const stageGroupIds = group.stages.flatMap((stage) => stageIds[stage]);
      return sameIds(statusGroupIds, stageGroupIds)
        ? []
        : [
            {
              check: "aging_deals",
              key: group.key,
              byStatus: statusGroupIds.length,
              byStage: stageGroupIds.length,
              opportunityIds: symmetricDifference(statusGroupIds, stageGroupIds),
            },
          ];
    }),
  );
  return true;
}

function sumAgingGroups(groups: PipelineAgingGroup[]): PipelineAgingGroup {
  const sum = emptyAgingGroup();
  for (const group of groups) {
    mergeAgingGroup(sum, group);
  }
  return sum;
}

function agingRow(group: PipelineAgingGroup) {
  return {
    count: group.count,
    averageAgeDays: group.count > 0 ? group.totalAgeDays / group.count : null,
    oldestAgeDays: group.count > 0 ? group.oldestAgeDays : null,
  };
}

/** The aging totals both ways, once every window is read. */
function agingTotalsDifferences(state: HealthCursor): HealthDifference[] {
  const differences: HealthDifference[] = [];
  const add = (check: string, key: string, byStatus: number | null, byStage: number | null, opportunityIds: Array<Id<"opportunities">> = []) =>
    differences.push({ check, key, byStatus, byStage, opportunityIds });

  for (const group of AGING_GROUPS) {
    const byStatus = agingRow(
      sumAgingGroups(group.statuses.map((status) => state.byStatus.groups[status])),
    );
    const byStage = agingRow(
      sumAgingGroups(group.stages.map((stage) => state.byStage.groups[stage])),
    );
    if (byStatus.count !== byStage.count) {
      add("aging_count", group.key, byStatus.count, byStage.count);
    }
    if (!approxEqual(byStatus.averageAgeDays, byStage.averageAgeDays)) {
      add("aging_average", group.key, byStatus.averageAgeDays, byStage.averageAgeDays);
    }
    if (!approxEqual(byStatus.oldestAgeDays, byStage.oldestAgeDays)) {
      add("aging_oldest", group.key, byStatus.oldestAgeDays, byStage.oldestAgeDays);
    }
  }
  if (state.byStatus.staleCount !== state.byStage.staleCount) {
    add("stale_count", "all", state.byStatus.staleCount, state.byStage.staleCount);
  }
  const statusTop = state.byStatus.staleTop.map((row) => row.opportunityId);
  const stageTop = state.byStage.staleTop.map((row) => row.opportunityId);
  if (statusTop.join() !== stageTop.join()) {
    add("stale_top", "top20", statusTop.length, stageTop.length, symmetricDifference(statusTop, stageTop));
  }
  return differences;
}

function velocityDifferences(byStatus: PipelineVelocity, byStage: PipelineVelocity): HealthDifference[] {
  const differences: HealthDifference[] = [];
  if (!approxEqual(byStatus.velocityDays, byStage.velocityDays)) {
    differences.push({
      check: "velocity_days",
      key: "all",
      byStatus: byStatus.velocityDays,
      byStage: byStage.velocityDays,
      opportunityIds: [],
    });
  }
  if (!sameIds(byStatus.opportunityIds, byStage.opportunityIds)) {
    differences.push({
      check: "velocity_deals",
      key: "all",
      byStatus: byStatus.opportunityIds.length,
      byStage: byStage.opportunityIds.length,
      opportunityIds: symmetricDifference(byStatus.opportunityIds, byStage.opportunityIds),
    });
  }
  if (byStatus.truncated !== byStage.truncated) {
    differences.push({
      check: "velocity_truncated",
      key: "all",
      byStatus: Number(byStatus.truncated),
      byStage: Number(byStage.truncated),
      opportunityIds: [],
    });
  }
  return differences;
}

function lossRow(losses: PipelineLosses) {
  const { lossCountsByActor, unknownLossCount } = countLossesByActor(losses.losses);
  return {
    count: losses.losses.length,
    unknown: unknownLossCount,
    byActor: [...lossCountsByActor.entries()]
      .map(([userId, count]) => ({ userId, count }))
      .sort((left, right) => (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)),
    truncated: losses.truncated,
    scanned: losses.scanned,
  };
}

function lossDifferences(byStatus: PipelineLosses, byStage: PipelineLosses): HealthDifference[] {
  const differences: HealthDifference[] = [];
  const statusIds = byStatus.losses.map((deal) => deal._id);
  const stageIds = byStage.losses.map((deal) => deal._id);
  if (!sameIds(statusIds, stageIds)) {
    differences.push({
      check: "loss_deals",
      key: "all",
      byStatus: statusIds.length,
      byStage: stageIds.length,
      opportunityIds: symmetricDifference(statusIds, stageIds),
    });
  }
  const statusCounts = countLossesByActor(byStatus.losses);
  const stageCounts = countLossesByActor(byStage.losses);
  const actors = new Set([
    ...statusCounts.lossCountsByActor.keys(),
    ...stageCounts.lossCountsByActor.keys(),
  ]);
  for (const actorId of [...actors].sort()) {
    const statusCount = statusCounts.lossCountsByActor.get(actorId) ?? 0;
    const stageCount = stageCounts.lossCountsByActor.get(actorId) ?? 0;
    if (statusCount !== stageCount) {
      differences.push({
        check: "loss_by_actor",
        key: actorId,
        byStatus: statusCount,
        byStage: stageCount,
        opportunityIds: [],
      });
    }
  }
  if (statusCounts.unknownLossCount !== stageCounts.unknownLossCount) {
    differences.push({
      check: "loss_unknown",
      key: "all",
      byStatus: statusCounts.unknownLossCount,
      byStage: stageCounts.unknownLossCount,
      opportunityIds: [],
    });
  }
  if (byStatus.truncated !== byStage.truncated) {
    differences.push({
      check: "loss_truncated",
      key: "all",
      byStatus: Number(byStatus.truncated),
      byStage: Number(byStage.truncated),
      opportunityIds: [],
    });
  }
  return differences;
}

export async function comparePipelineHealthPage(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDate: number;
    endDate: number;
    cursor?: HealthCursor;
    limits?: { docBudget?: number; windowDays?: number; windowDocCap?: number };
  },
): Promise<Infer<typeof comparePipelineHealthReturns>> {
  assertValidDateRange(args.startDate, args.endDate);
  const docBudget = positiveLimit(args.limits?.docBudget, CALL_DOC_BUDGET, "docBudget");
  const maxWindowSize =
    positiveLimit(args.limits?.windowDays, DEFAULT_WINDOW_DAYS, "windowDays") * DAY_MS;
  const windowDocCap = positiveLimit(args.limits?.windowDocCap, WINDOW_DOC_CAP, "windowDocCap");
  const state = args.cursor ? copyCursor(args.cursor) : initialHealthCursor(maxWindowSize);
  const { tenantId } = args;
  const now = Date.now();
  const meter = newReadMeter();

  if (state.phase === "aging" && state.windowFrom === null) {
    const earliest = await earliestOpenCreatedAt(ctx, tenantId, meter);
    if (earliest === null) {
      state.phase = "rest";
    } else {
      state.windowFrom = earliest;
    }
  }

  while (state.phase === "aging" && state.windowFrom !== null && !overBudget(meter, docBudget)) {
    const from = state.windowFrom;
    // The last window runs to the end, so a deal created since is read too.
    const to = from + state.windowSize > now ? undefined : from + state.windowSize;
    const read = await compareAgingWindow(ctx, tenantId, now, state, { from, to }, windowDocCap, meter);
    if (!read) {
      if (state.windowSize <= 1) {
        throw new Error(
          `More than ${windowDocCap} open deals were created at ${from}; rerun with a larger windowDocCap`,
        );
      }
      state.windowSize = Math.max(1, Math.floor(state.windowSize / 4));
      continue;
    }
    if (to === undefined) {
      state.phase = "rest";
    } else {
      state.windowFrom = to;
      state.windowSize = Math.min(maxWindowSize, state.windowSize * 2);
    }
  }

  let velocity: Infer<typeof comparePipelineHealthReturns>["velocity"] = null;
  let lossAttribution: Infer<typeof comparePipelineHealthReturns>["lossAttribution"] = null;
  const finalDifferences: HealthDifference[] = [];
  // Velocity and losses read up to ~7,000 deals together, so they get a call
  // of their own unless the aging read little in this one.
  const isDone =
    state.phase === "rest" &&
    meter.docs < docBudget / 2 &&
    meter.bytes < CALL_BYTE_BUDGET / 2;
  if (isDone) {
    const statusVelocity = await readPipelineVelocityByStatus(ctx, tenantId, now, meter);
    const stageVelocity = await readPipelineVelocityByStage(ctx, tenantId, now, meter);
    const statusLosses = await readLossesByStatus(ctx, tenantId, args.startDate, args.endDate, meter);
    const stageLosses = await readLossesByStage(ctx, tenantId, args.startDate, args.endDate, meter);
    velocity = {
      byStatus: {
        velocityDays: statusVelocity.velocityDays,
        wonCount: statusVelocity.opportunityIds.length,
        truncated: statusVelocity.truncated,
      },
      byStage: {
        velocityDays: stageVelocity.velocityDays,
        wonCount: stageVelocity.opportunityIds.length,
        truncated: stageVelocity.truncated,
      },
    };
    lossAttribution = { byStatus: lossRow(statusLosses), byStage: lossRow(stageLosses) };
    finalDifferences.push(
      ...agingTotalsDifferences(state),
      ...velocityDifferences(statusVelocity, stageVelocity),
      ...lossDifferences(statusLosses, stageLosses),
    );
  }

  const result = { differences: [...state.differences], differenceCount: state.differenceCount };
  appendDifferences(result, finalDifferences);
  return {
    aging: {
      byStatus: {
        qualified_pending: agingRow(state.byStatus.groups.qualified_pending),
        scheduled: agingRow(state.byStatus.groups.scheduled),
        follow_up_scheduled: agingRow(state.byStatus.groups.follow_up_scheduled),
        reschedule_link_sent: agingRow(state.byStatus.groups.reschedule_link_sent),
      },
      byStage: {
        qualified: agingRow(state.byStage.groups.qualified),
        booked: agingRow(state.byStage.groups.booked),
        call_held: agingRow(state.byStage.groups.call_held),
        follow_up: agingRow(state.byStage.groups.follow_up),
      },
      staleCount: { byStatus: state.byStatus.staleCount, byStage: state.byStage.staleCount },
      staleTop: { byStatus: state.byStatus.staleTop, byStage: state.byStage.staleTop },
      scanned: { byStatus: state.byStatus.scanned, byStage: state.byStage.scanned },
      windows: state.windows,
    },
    velocity,
    lossAttribution,
    differences: result.differences,
    differenceCount: result.differenceCount,
    ok: result.differenceCount === 0,
    isDone,
    continueCursor: isDone ? null : state,
  };
}

// ── compareTeamOutcomes ─────────────────────────────────────────────────
// The team report's outcome mix per closer: each meeting's outcome from its
// deal's status and from its stage, from the same inputs. Expected: equal for
// every meeting (§7).
//
// Pages over the meetings scheduled in the range (by_tenantId_and_scheduledAt),
// each page reading its meetings' deals and the range's payments, as the
// report does. A meeting counts as rescheduled when a meeting on the same page
// reschedules it, so a range over one page gives the report's own numbers.
// Production: 1,000 meetings a page; a month from 2026-04 holds up to ~1,300
// meetings, so 1 to 2 calls a month, about 10 for April to October.

const callOutcomeValidator = v.union(
  v.literal("sold"),
  v.literal("lost"),
  v.literal("no_show"),
  v.literal("canceled"),
  v.literal("rescheduled"),
  v.literal("dq"),
  v.literal("follow_up"),
  v.literal("scheduled"),
);

const outcomeCountsValidator = v.object({
  sold: v.number(),
  lost: v.number(),
  no_show: v.number(),
  canceled: v.number(),
  rescheduled: v.number(),
  dq: v.number(),
  follow_up: v.number(),
  scheduled: v.number(),
});

const closerOutcomesValidator = v.object({
  closerId: v.id("users"),
  byStatus: outcomeCountsValidator,
  byStage: outcomeCountsValidator,
});

const meetingDifferenceValidator = v.object({
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  closerId: v.id("users"),
  byStatus: callOutcomeValidator,
  byStage: callOutcomeValidator,
});

const teamOutcomesCursorValidator = v.object({
  meetingsCursor: v.union(v.string(), v.null()),
  closers: v.array(closerOutcomesValidator),
  meetingsCompared: v.number(),
  // A page found more than the report's 2,000 payments in the range.
  paymentsTruncated: v.boolean(),
  differences: v.array(meetingDifferenceValidator),
  differenceCount: v.number(),
});

type TeamOutcomesCursor = Infer<typeof teamOutcomesCursorValidator>;

export const compareTeamOutcomesArgs = {
  tenantId: v.id("tenants"),
  startDate: v.number(),
  endDate: v.number(),
  cursor: v.optional(teamOutcomesCursorValidator),
  // Meetings a call reads (at most 2,000).
  pageSize: v.optional(v.number()),
};

export const compareTeamOutcomesReturns = v.object({
  closers: v.array(closerOutcomesValidator),
  team: v.object({ byStatus: outcomeCountsValidator, byStage: outcomeCountsValidator }),
  meetingsCompared: v.number(),
  paymentsTruncated: v.boolean(),
  differences: v.array(meetingDifferenceValidator),
  differenceCount: v.number(),
  // What this call read.
  read: v.object({ docs: v.number(), bytes: v.number(), ranges: v.number() }),
  ok: v.boolean(),
  isDone: v.boolean(),
  continueCursor: v.union(teamOutcomesCursorValidator, v.null()),
});

function addOutcomeCounts(target: OutcomeCounts, outcome: keyof OutcomeCounts): void {
  target[outcome] += 1;
}

function sumOutcomeCounts(rows: OutcomeCounts[]): OutcomeCounts {
  const sum = emptyOutcomeCounts();
  for (const row of rows) {
    for (const outcome of Object.keys(sum) as Array<keyof OutcomeCounts>) {
      sum[outcome] += row[outcome];
    }
  }
  return sum;
}

export async function compareTeamOutcomesPage(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDate: number;
    endDate: number;
    cursor?: TeamOutcomesCursor;
    pageSize?: number;
  },
): Promise<Infer<typeof compareTeamOutcomesReturns>> {
  assertValidDateRange(args.startDate, args.endDate);
  const pageSize = Math.min(
    positiveLimit(args.pageSize, DEFAULT_MEETING_PAGE, "pageSize"),
    MAX_MEETING_PAGE,
  );
  const state: TeamOutcomesCursor = args.cursor
    ? copyCursor(args.cursor)
    : {
        meetingsCursor: null,
        closers: [],
        meetingsCompared: 0,
        paymentsTruncated: false,
        differences: [],
        differenceCount: 0,
      };
  const meter = newReadMeter();

  const inputs = await readTeamOutcomeInputs(
    ctx,
    args.tenantId,
    args.startDate,
    args.endDate,
    { cursor: state.meetingsCursor, numItems: pageSize },
    meter,
  );
  const byStatus = meetingOutcomesByStatus(inputs);
  const byStage = new Map(
    (await meetingOutcomesByStage(ctx, inputs, meter)).map((row) => [row.meeting._id, row.outcome]),
  );

  const closers = new Map(state.closers.map((row) => [row.closerId, row]));
  for (const { meeting, opportunity, outcome } of byStatus) {
    const stageOutcome = byStage.get(meeting._id) ?? outcome;
    const closerId = meeting.assignedCloserId;
    let row = closers.get(closerId);
    if (!row) {
      row = { closerId, byStatus: emptyOutcomeCounts(), byStage: emptyOutcomeCounts() };
      closers.set(closerId, row);
    }
    addOutcomeCounts(row.byStatus, outcome);
    addOutcomeCounts(row.byStage, stageOutcome);
    state.meetingsCompared += 1;
    if (stageOutcome !== outcome) {
      appendDifferences(state, [
        {
          meetingId: meeting._id,
          opportunityId: opportunity._id,
          closerId,
          byStatus: outcome,
          byStage: stageOutcome,
        },
      ]);
    }
  }
  state.closers = [...closers.values()].sort((left, right) =>
    left.closerId < right.closerId ? -1 : left.closerId > right.closerId ? 1 : 0,
  );
  state.meetingsCursor = inputs.continueCursor;
  state.paymentsTruncated ||= inputs.isTruncated;

  const isDone = inputs.isDone;
  return {
    closers: state.closers,
    team: {
      byStatus: sumOutcomeCounts(state.closers.map((row) => row.byStatus)),
      byStage: sumOutcomeCounts(state.closers.map((row) => row.byStage)),
    },
    meetingsCompared: state.meetingsCompared,
    paymentsTruncated: state.paymentsTruncated,
    differences: state.differences,
    differenceCount: state.differenceCount,
    read: { docs: meter.docs, bytes: meter.bytes, ranges: meter.ranges },
    ok: state.differenceCount === 0,
    isDone,
    continueCursor: isDone ? null : state,
  };
}

// ── compareCloseRates ───────────────────────────────────────────────────
// The closer dashboard strip in its period: each closer's won and lost, and
// so the close rate, both ways, and its segments, positions against their
// statuses. The stage way's lost leaves out the losses the system wrote, so
// it equals today's, which counts status `lost` only (§6.2). Expected: equal.
//
// Production: a closer's meetings in the range and their deals, one get per
// deal. A month is ~1,300 meetings and ~1,200 gets over the 22 closers, so 1
// to 2 calls; all time (~6,900 meetings, ~6,000 gets) about 5.

const stripByStatusValidator = v.object({
  won: v.number(),
  lost: v.number(),
  closeRate: v.union(v.number(), v.null()),
  counts: statusCountsValidator,
  total: v.number(),
});

const stripByStageValidator = v.object({
  won: v.number(),
  lost: v.number(),
  closeRate: v.union(v.number(), v.null()),
  counts: positionCountsValidator,
  total: v.number(),
});

const closerStripValidator = v.object({
  closerId: v.id("users"),
  byStatus: stripByStatusValidator,
  byStage: stripByStageValidator,
});

const closeRateDifferenceValidator = v.object({
  closerId: v.id("users"),
  // "won", "lost", or "segment:" and the positions compared.
  check: v.string(),
  byStatus: v.number(),
  byStage: v.number(),
  opportunityIds: v.array(v.id("opportunities")),
});

const closeRatesCursorValidator = v.object({
  afterCreationTime: v.union(v.number(), v.null()),
  closers: v.array(closerStripValidator),
  differences: v.array(closeRateDifferenceValidator),
  differenceCount: v.number(),
});

type CloseRatesCursor = Infer<typeof closeRatesCursorValidator>;

export const compareCloseRatesArgs = {
  tenantId: v.id("tenants"),
  startDate: v.number(),
  endDate: v.number(),
  cursor: v.optional(closeRatesCursorValidator),
  // Documents read in one call before it stops starting closers.
  docBudget: v.optional(v.number()),
};

export const compareCloseRatesReturns = v.object({
  closers: v.array(closerStripValidator),
  differences: v.array(closeRateDifferenceValidator),
  differenceCount: v.number(),
  // What this call read.
  read: v.object({ docs: v.number(), bytes: v.number(), ranges: v.number() }),
  ok: v.boolean(),
  isDone: v.boolean(),
  continueCursor: v.union(closeRatesCursorValidator, v.null()),
});

function closeRate(won: number, lost: number): number | null {
  return won + lost > 0 ? won / (won + lost) : null;
}

function closeRateDifferences(
  closerId: Id<"users">,
  deals: Array<Doc<"opportunities">>,
  byStatus: ReturnType<typeof countStripByStatus>,
  byStage: ReturnType<typeof countStripByStage>,
) {
  const positionOf = (deal: Doc<"opportunities">) => {
    const { stage, outcome } = dealStageOf(deal);
    return dealPosition(stage, outcome);
  };
  const differingDeals = (statusSide: (deal: Doc<"opportunities">) => boolean, stageSide: (deal: Doc<"opportunities">) => boolean) =>
    deals
      .filter((deal) => statusSide(deal) !== stageSide(deal))
      .map((deal) => deal._id)
      .slice(0, MAX_DIFFERENCE_IDS);

  const differences: Array<Infer<typeof closeRateDifferenceValidator>> = [];
  if (byStatus.counts.payment_received !== byStage.won) {
    differences.push({
      closerId,
      check: "won",
      byStatus: byStatus.counts.payment_received,
      byStage: byStage.won,
      opportunityIds: differingDeals(
        (deal) => deal.status === "payment_received",
        (deal) => positionOf(deal) === "won",
      ),
    });
  }
  if (byStatus.counts.lost !== byStage.lost) {
    differences.push({
      closerId,
      check: "lost",
      byStatus: byStatus.counts.lost,
      byStage: byStage.lost,
      opportunityIds: differingDeals((deal) => deal.status === "lost", isPersonLoss),
    });
  }
  for (const group of positionGroupDifferences(byStage.counts, byStatus.counts)) {
    differences.push({
      closerId,
      check: `segment:${group.positions.join("+")}`,
      byStatus: group.byStatus,
      byStage: group.byStage,
      opportunityIds: differingDeals(
        (deal) => (group.statuses as (string | undefined)[]).includes(deal.status),
        (deal) => group.positions.includes(positionOf(deal)),
      ),
    });
  }
  return differences;
}

export async function compareCloseRatesPage(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    startDate: number;
    endDate: number;
    cursor?: CloseRatesCursor;
    docBudget?: number;
  },
): Promise<Infer<typeof compareCloseRatesReturns>> {
  assertValidDateRange(args.startDate, args.endDate);
  const docBudget = positiveLimit(args.docBudget, CALL_DOC_BUDGET, "docBudget");
  const state: CloseRatesCursor = args.cursor
    ? copyCursor(args.cursor)
    : { afterCreationTime: null, closers: [], differences: [], differenceCount: 0 };
  const meter = newReadMeter();

  const users = await readTenantUsers(ctx, args.tenantId, state.afterCreationTime, meter);
  let stopped = false;
  let processed = 0;
  for (const user of users) {
    if (user.role === "closer") {
      if (processed > 0 && overBudget(meter, docBudget)) {
        stopped = true;
        break;
      }
      const deals = await readCloserMeetingDeals(
        ctx,
        args.tenantId,
        user._id,
        args.startDate,
        args.endDate,
        meter,
      );
      const byStatus = countStripByStatus(deals);
      const byStage = countStripByStage(deals);
      state.closers.push({
        closerId: user._id,
        byStatus: {
          won: byStatus.counts.payment_received,
          lost: byStatus.counts.lost,
          closeRate: closeRate(byStatus.counts.payment_received, byStatus.counts.lost),
          counts: byStatus.counts,
          total: byStatus.total,
        },
        byStage: {
          won: byStage.won,
          lost: byStage.lost,
          closeRate: closeRate(byStage.won, byStage.lost),
          counts: byStage.counts,
          total: byStage.total,
        },
      });
      appendDifferences(state, closeRateDifferences(user._id, deals, byStatus, byStage));
      processed += 1;
    }
    state.afterCreationTime = user._creationTime;
  }

  const isDone = !stopped && users.length < MAX_TENANT_USERS;
  return {
    closers: state.closers,
    differences: state.differences,
    differenceCount: state.differenceCount,
    read: { docs: meter.docs, bytes: meter.bytes, ranges: meter.ranges },
    ok: state.differenceCount === 0,
    isDone,
    continueCursor: isDone ? null : state,
  };
}
