import { describe, expect, it } from "vitest";
import { addBusinessDays, businessDayStart, DEFAULT_BUSINESS_DAY } from "../../../lib/businessDay";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { slackQualificationsByTime, slackQualificationsByUser } from "../../reporting/aggregates";
import { qualificationReportPeriods } from "../../reporting/slackQualifications";

const identity = { subject: "user_admin", org_id: "org_test" };
// The report runs on the tenant's business day.
const range = {
  startDate: "2026-09-28",
  endDateInclusive: "2026-10-09",
  fromMs: businessDayStart("2026-09-28", DEFAULT_BUSINESS_DAY),
  toMs: businessDayStart("2026-10-10", DEFAULT_BUSINESS_DAY),
  timeZone: DEFAULT_BUSINESS_DAY.timeZone,
  dayStartHour: DEFAULT_BUSINESS_DAY.dayStartHour,
};
const HOUR = 60 * 60 * 1000;

async function createFixture() {
  const harness = await bookingHarness();
  await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    await ctx.db.patch("tenants", tenantId, { slackQualificationDailyTeamQuota: 2 });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1",
      botAccessToken: "token", scopes: [], installedByWorkosUserId: "user_admin", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "refresh", status: "active",
    });
    const setter = (slackUserId: string, fields: Partial<Doc<"slackUsers">> = {}) =>
      ctx.db.insert("slackUsers", {
        tenantId, installationId, slackUserId, slackTeamId: "T1", isBot: false, isDeleted: false,
        firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0, ...fields,
      });
    await setter("U1", { displayName: "Ana" });
    await setter("U2", { realName: "Beto" });
    await setter("U3", { displayName: "Idle" });
    await setter("UBOT", { isBot: true });
    const leadId = await ctx.db.insert("leads", { tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0 });
    const deal = async (source: Doc<"opportunities">["source"], qualifiedBy?: Doc<"opportunities">["qualifiedBy"]) => {
      const id = await ctx.db.insert("opportunities", {
        tenantId, leadId, stage: "qualified", outcome: "open", source, qualifiedBy, createdAt: 0, updatedAt: 0, latestActivityAt: 0,
      });
      const doc = (await ctx.db.get("opportunities", id))!;
      if (source === "slack_qualified" && qualifiedBy) {
        await slackQualificationsByUser.insert(ctx, doc);
        await slackQualificationsByTime.insert(ctx, doc);
      }
      return id;
    };
    const qualify = async (
      slackUserId: string,
      submittedAt: number,
      resultKind: Doc<"slackQualificationEvents">["resultKind"],
      opportunityId?: Id<"opportunities">,
    ) => {
      await ctx.db.insert("slackQualificationEvents", {
        tenantId, installationId, leadId, opportunityId, resultKind,
        qualifiedBy: { slackUserId, slackTeamId: "T1", submittedAt },
        slackUserId, slackTeamId: "T1", fullNameSnapshot: "Lead", platform: "instagram", handleSnapshot: "@lead",
        submittedAt, createdAt: submittedAt,
      });
    };
    const day = (date: string, hour = 3) => businessDayStart(date, DEFAULT_BUSINESS_DAY) + hour * HOUR;
    const slackDeal = await deal("slack_qualified", { slackUserId: "U1", slackTeamId: "T1", submittedAt: day("2026-09-29") });
    await qualify("U1", day("2026-09-29"), "created_opportunity", slackDeal);
    // The same deal again in the next week: one unique deal in the range,
    // one in each week.
    await qualify("U2", day("2026-10-06"), "duplicate_pending", slackDeal);
    const calendlyDeal = await deal("calendly");
    await qualify("U1", day("2026-10-06", 5), "already_booked", calendlyDeal);
    await qualify("U2", day("2026-10-07"), "unlinked");
    const secondDeal = await deal("slack_qualified", { slackUserId: "U2", slackTeamId: "T1", submittedAt: day("2026-10-08") });
    await qualify("U2", day("2026-10-08"), "created_opportunity", secondDeal);
    // Before the range, and the business day's first hour, which belongs to
    // the day before.
    await qualify("U1", day("2026-09-28", -1), "created_opportunity", await deal("slack_qualified", { slackUserId: "U1", slackTeamId: "T1", submittedAt: day("2026-09-28", -1) }));
  });
  return harness;
}

type Filters = { granularity: "day" | "week" | "month"; slackUserId: string | null };

// What the report's SQL returns: summarizeQualificationEvents in total, per
// period and per setter.
async function reportRows(ctx: MutationCtx, filters: Filters) {
  const events = (await ctx.db.query("slackQualificationEvents").take(100)).filter(
    (event) => event.submittedAt >= range.fromMs && event.submittedAt < range.toMs &&
      (filters.slackUserId === null || event.slackUserId === filters.slackUserId),
  );
  const deals = await ctx.db.query("opportunities").take(100);
  const slackDeals = new Set(deals.filter((deal) => deal.source === "slack_qualified").map((deal) => deal._id as string));
  const summarize = (rows: typeof events) => ({
    qualification_event_count: rows.length,
    unique_linked_opportunity_count: new Set(rows.flatMap((row) => (row.opportunityId ? [row.opportunityId] : []))).size,
    unique_slack_opportunity_count: new Set(rows.flatMap((row) => (row.opportunityId && slackDeals.has(row.opportunityId) ? [row.opportunityId] : []))).size,
    created_opportunity_events: rows.filter((row) => row.resultKind === "created_opportunity").length,
    duplicate_pending_events: rows.filter((row) => row.resultKind === "duplicate_pending").length,
    already_booked_events: rows.filter((row) => row.resultKind === "already_booked").length,
    unlinked_events: rows.filter((row) => row.resultKind === "unlinked").length,
  });
  const periods = qualificationReportPeriods(
    {
      startBusinessDate: range.startDate,
      endBusinessDateExclusive: addBusinessDays(range.endDateInclusive, 1),
      granularity: filters.granularity,
    },
    DEFAULT_BUSINESS_DAY,
  );
  const periodIndex = (at: number) => periods.findLastIndex((period) => period.start <= at) + 1;
  const indexes = [...new Set(events.map((event) => periodIndex(event.submittedAt)))];
  const setters = [...new Set(events.map((event) => event.slackUserId))];
  const legacy = deals.filter(
    (deal) => deal.source === "slack_qualified" && deal.qualifiedBy &&
      deal.qualifiedBy.submittedAt >= range.fromMs && deal.qualifiedBy.submittedAt < range.toMs &&
      (filters.slackUserId === null || deal.qualifiedBy.slackUserId === filters.slackUserId),
  ).length;
  return {
    totals: [summarize(events)],
    periods: indexes.map((index) => ({
      period_index: index,
      ...summarize(events.filter((event) => periodIndex(event.submittedAt) === index)),
    })),
    setters: setters.map((slackUserId) => {
      const own = events.filter((event) => event.slackUserId === slackUserId);
      return { slack_user_id: slackUserId, last_qualified_at_ms: Math.max(...own.map((event) => event.submittedAt)), ...summarize(own) };
    }),
    legacy: [{ count: legacy }],
  };
}

describe("Slack Qualifications from ClickHouse rows", () => {
  it("matches the report for the team and for one setter", async () => {
    const { t, tenantId } = await createFixture();
    const liveRange = { startBusinessDate: range.startDate, endBusinessDateExclusive: addBusinessDays(range.endDateInclusive, 1) };
    const check = async (filters: Filters) =>
      await expectSameAnswer({
        t, identity, tenantId, range,
        rows: await t.run((ctx) => reportRows(ctx, filters)),
        reportId: "slack_qualifications.report",
        live: api.reporting.slackQualifications.getQualificationReport,
        liveArgs: { ...liveRange, granularity: filters.granularity, ...(filters.slackUserId ? { slackUserId: filters.slackUserId } : {}) },
        filters,
      });

    const team = await check({ granularity: "week", slackUserId: null });
    expect(team.totals).toMatchObject({
      totalQualified: 5,
      uniqueLinkedOpportunityCount: 3,
      uniqueSlackOpportunityCount: 2,
      legacyOpportunityAggregateCount: 2,
    });
    expect(team.periods.map((period: { uniqueSlackOpportunityCount: number }) => period.uniqueSlackOpportunityCount)).toEqual([1, 2]);
    expect(team.users.map((user: { totalQualified: number }) => user.totalQualified)).toEqual([3, 2, 0]);
    await check({ granularity: "day", slackUserId: null });
    const setter = await check({ granularity: "week", slackUserId: "U2" });
    expect(setter.totals.totalQualified).toBe(3);
  });
});
