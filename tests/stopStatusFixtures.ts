import { expect, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import { legacyStatus, loadPendingRescheduleLink } from "../convex/opportunities/dealState";
import { opportunityByStatus } from "../convex/reporting/aggregates";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import type { EnrollmentHarness } from "./enrollmentFixtures";

// Phase 5 PR 9 (docs/plans/phase-5-deal-status.md §9, §10.6): nothing writes
// the deal status or a copy of it, and the clears unset what PR 8 left.

/** A Slack installation, so the qualification path can post. */
export async function insertSlackInstallation(harness: EnrollmentHarness) {
  return await harness.t.run((ctx) =>
    ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
}

/** A Slack qualification that creates a deal at Qualified. */
export async function qualifyInSlack(harness: EnrollmentHarness, handle = "@slack.lead") {
  const installationId = await insertSlackInstallation(harness);
  await harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Slack Lead",
    handle,
    country: "Mexico",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: Date.now() },
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await harness.t.run(async (ctx) => {
    const deal = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("source", "slack_qualified"),
      )
      .order("desc")
      .first();
    return deal!._id;
  });
}

/**
 * The old status the deal's stage, loss and pending reschedule link name
 * (`legacyStatus`, §4.6): what PR 7 would have stored, for the tests that
 * compare a write with PR 7's. The deal stores none from PR 9.
 */
export async function namedStatus(
  ctx: QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<OpportunityStatus> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const { count } = await loadPendingRescheduleLink(ctx, opportunityId);
  return legacyStatus(deal, { hasPendingRescheduleLink: count > 0 });
}

const STATUS_COUNTERS = ["activeOpportunities", "wonDeals", "lostDeals"] as const;

/**
 * Every copy of the deal status in the tenant's rows: none is written from
 * PR 9, so every list is empty and every count zero.
 */
export async function statusCopies(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const deals = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(200);
  const searchRows = await ctx.db.query("opportunitySearch").take(200);
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId))
    .take(200);
  const qualificationRows = await ctx.db.query("operationsQualificationRows").take(200);
  const projections = await ctx.db.query("meetingProjections").take(200);
  const buckets = await ctx.db.query("operationsMeetingStatsV2").take(200);
  const stats = await ctx.db
    .query("tenantStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();
  return {
    dealStatuses: deals.flatMap((deal) => (deal.status === undefined ? [] : [deal.status])),
    searchRowStatuses: searchRows.flatMap((row) => (row.status === undefined ? [] : [row.status])),
    meetingStatuses: meetings.flatMap((meeting) =>
      meeting.opportunityStatus === undefined ? [] : [meeting.opportunityStatus],
    ),
    qualificationRowStatuses: qualificationRows.flatMap((row) =>
      row.opportunityStatus === undefined ? [] : [row.opportunityStatus],
    ),
    contributionStatuses: projections.flatMap((projection) =>
      projection.contribution?.opportunityStatus === undefined ? [] : [projection.contribution.opportunityStatus],
    ),
    bucketStatuses: buckets.flatMap((bucket) =>
      bucket.opportunityStatus === undefined ? [] : [bucket.opportunityStatus],
    ),
    statusAggregateEntries: await opportunityByStatus.count(ctx, { namespace: tenantId }),
    statusCounters: STATUS_COUNTERS.filter((field) => stats?.[field] !== undefined),
  };
}

export const NO_STATUS_COPIES = {
  dealStatuses: [],
  searchRowStatuses: [],
  meetingStatuses: [],
  qualificationRowStatuses: [],
  contributionStatuses: [],
  bucketStatuses: [],
  statusAggregateEntries: 0,
  statusCounters: [],
};

/** The tenant's rows have no status anywhere. */
export async function expectNoStatusCopies(harness: EnrollmentHarness) {
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await harness.t.run((ctx) => statusCopies(ctx, harness.tenantId))).toEqual(NO_STATUS_COPIES);
}

/**
 * The status and its copies as PR 8 left them, before the clears: each deal
 * stores `status`, its search row, meetings and qualification rows copy it,
 * the legacy daily stats row and `opportunityByStatus` hold it, and
 * tenantStats has the three counters.
 */
export async function withPr8StatusCopies(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  status: OpportunityStatus = "scheduled",
) {
  const deals = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(200);
  for (const deal of deals) {
    await ctx.db.patch("opportunities", deal._id, { status });
    await opportunityByStatus.insertIfDoesNotExist(ctx, (await ctx.db.get("opportunities", deal._id))!);
    const search = await ctx.db
      .query("opportunitySearch")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", deal._id))
      .unique();
    if (search) await ctx.db.patch("opportunitySearch", search._id, { status });
    for (const meeting of await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", deal._id))
      .take(20)) {
      await ctx.db.patch("meetings", meeting._id, { opportunityStatus: status });
    }
  }
  for (const row of await ctx.db.query("operationsQualificationRows").take(200)) {
    await ctx.db.patch("operationsQualificationRows", row._id, { opportunityStatus: status });
  }
  const closerId = (await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(10)).find((user) => user.role === "closer")!._id;
  await ctx.db.insert("operationsMeetingDailyStats", {
    tenantId,
    dayKey: "2026-10-01",
    assignedCloserId: closerId,
    opportunityStatus: status,
    meetingStatus: "scheduled",
    count: 1,
    updatedAt: 0,
  });
  const stats = await ctx.db
    .query("tenantStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();
  const counters = { activeOpportunities: deals.length, wonDeals: 0, lostDeals: 0 };
  if (stats) {
    await ctx.db.patch("tenantStats", stats._id, counters);
  } else {
    await ctx.db.insert("tenantStats", {
      tenantId, totalTeamMembers: 0, totalClosers: 0, totalOpportunities: deals.length, totalRevenueMinor: 0,
      totalPaymentRecords: 0, totalLeads: 0, totalCustomers: 0, lastUpdatedAt: 0, ...counters,
    });
  }
}

/** A table's rows, oldest first, for comparing before and after a clear. */
export async function rowsOf<Table extends ClearedTable>(ctx: QueryCtx, table: Table) {
  return (await ctx.db.query(table).take(200)) as Array<Doc<Table>>;
}

type ClearedTable =
  | "opportunities"
  | "opportunitySearch"
  | "meetings"
  | "operationsQualificationRows"
  | "operationsMeetingDailyStats";

/** Drops `field` from each row, as the clear leaves it. */
export function without<Row extends Record<string, unknown>>(rows: Row[], field: keyof Row): Row[] {
  return rows.map((row) => {
    const { [field]: _dropped, ...rest } = row;
    return rest as Row;
  });
}

/**
 * The clear's contract (§10.6): its assert fails before, naming a row; a dry
 * run writes nothing; the run unsets `field` on every row of `table` and
 * changes nothing else; the assert passes after; a rerun writes nothing.
 */
export async function expectClear(
  harness: EnrollmentHarness,
  spec: { clear: string; assert: string; table: ClearedTable; field: string },
) {
  const before = await harness.t.run((ctx) => rowsOf(ctx, spec.table));
  expect(before.some((row) => (row as Record<string, unknown>)[spec.field] !== undefined)).toBe(true);

  const failed = (await harness.run(spec.assert))?.error;
  expect(failed).toBeDefined();
  expect(before.some((row) => failed?.includes(row._id))).toBe(true);

  await harness.t.mutation(internal.migrations.run, { fn: `migrations:${spec.clear}`, dryRun: true });
  expect(await harness.t.run((ctx) => rowsOf(ctx, spec.table))).toEqual(before);

  expect((await harness.run(spec.clear))?.error).toBeUndefined();
  const after = await harness.t.run((ctx) => rowsOf(ctx, spec.table));
  expect(after).toEqual(without(before as Array<Record<string, unknown>>, spec.field));
  expect((await harness.rerun(spec.assert))?.error).toBeUndefined();

  expect((await harness.rerun(spec.clear))?.error).toBeUndefined();
  expect(await harness.t.run((ctx) => rowsOf(ctx, spec.table))).toEqual(after);
}
