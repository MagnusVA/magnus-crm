import { describe, expect, it } from "vitest";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "../../../lib/businessDay";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { slackQualificationsByTime, slackQualificationsByUser } from "../../reporting/aggregates";
import { mergeSlackQualifications } from "./slackQualifications";
const HOUR = 3_600_000;
const identity = { subject: "user_admin", org_id: "org_test" };

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
    await qualify("U2", day("2026-09-30"), "unlinked");
    // The same deal again in the next week: one unique deal in the range,
    // one in each week.
    await qualify("U2", day("2026-10-06"), "duplicate_pending", slackDeal);
    await qualify("U1", day("2026-10-06", 4), "duplicate_pending", slackDeal);
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


describe("Slack Qualifications across the split", () => {
  it("merges every granularity for the team and each setter", async () => {
    const { t } = await createFixture();
    for (const granularity of ["day", "week", "month"] as const) {
      for (const slackUserId of [undefined, "U1", "U2"]) {
        const filters = { granularity, ...(slackUserId ? { slackUserId } : {}) };
        const windows = {
          history: { startBusinessDate: "2026-09-28", endBusinessDateExclusive: "2026-10-06", ...filters },
          today: { startBusinessDate: "2026-10-06", endBusinessDateExclusive: "2026-10-10", ...filters },
          whole: { startBusinessDate: "2026-09-28", endBusinessDateExclusive: "2026-10-10", ...filters },
        };
        const whole = await t.withIdentity(identity).query(api.reporting.slackQualifications.getQualificationReport, windows.whole);
        const answers = await expectMergedAnswer({
          t, identity, live: api.reporting.slackQualifications.getQualificationReport, ...windows,
          merge: (history, today) => {
            const result = mergeSlackQualifications(history, today);
            // Ignore only the distinct counts, then check their sum formula below.
            return {
              ...result,
              totals: { ...result.totals, uniqueLinkedOpportunityCount: whole.totals.uniqueLinkedOpportunityCount, uniqueSlackOpportunityCount: whole.totals.uniqueSlackOpportunityCount },
              users: result.users.map((row) => ({ ...row, uniqueSlackOpportunityCount: whole.users.find((user) => user.slackUserId === row.slackUserId)!.uniqueSlackOpportunityCount })),
              periods: result.periods.map((row) => ({ ...row, uniqueSlackOpportunityCount: whole.periods.find((period) => period.key === row.key)!.uniqueSlackOpportunityCount })),
            };
          },
        });
        expect(answers.history.totals.totalQualified).toBeGreaterThan(0);
        expect(answers.today.totals.totalQualified).toBeGreaterThan(0);
        const merged = mergeSlackQualifications(answers.history, answers.today);
        expect(merged.totals.uniqueLinkedOpportunityCount).toBe(answers.history.totals.uniqueLinkedOpportunityCount + answers.today.totals.uniqueLinkedOpportunityCount);
        expect(merged.totals.uniqueSlackOpportunityCount).toBe(answers.history.totals.uniqueSlackOpportunityCount + answers.today.totals.uniqueSlackOpportunityCount);
        for (const row of merged.users) {
          expect(row.uniqueSlackOpportunityCount).toBe((answers.history.users.find((user) => user.slackUserId === row.slackUserId)?.uniqueSlackOpportunityCount ?? 0) + (answers.today.users.find((user) => user.slackUserId === row.slackUserId)?.uniqueSlackOpportunityCount ?? 0));
        }
        for (const row of merged.periods) {
          expect(row.uniqueSlackOpportunityCount).toBe((answers.history.periods.find((period) => period.key === row.key)?.uniqueSlackOpportunityCount ?? 0) + (answers.today.periods.find((period) => period.key === row.key)?.uniqueSlackOpportunityCount ?? 0));
        }
      }
    }
  });
});
