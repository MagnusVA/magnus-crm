import { describe, expect, it } from "vitest";
import { bookingHarness } from "../../../tests/bookingHarness";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import {
  DAY,
  fixtureUsers,
  insertMeeting,
  insertPerson,
  insertProgram,
  seedCustomer,
} from "../../../tests/enrollmentReadFixtures";
import { api } from "../../_generated/api";
import { readLifecycle, syncLeadStageEntries } from "../../lib/leadLifecycle";
import {
  mergeAnswerDistribution,
  mergeFormResponseKpis,
  mergeLeadConversionMetrics,
} from "./leads";

const from = Date.parse("2026-05-01T06:00:00Z");
const split = Date.parse("2026-05-17T06:00:00Z");
const to = Date.parse("2026-06-01T06:00:00Z");
const identity = { subject: "user_admin", org_id: "org_test" };
const windows = {
  history: { startDate: from, endDate: split },
  today: { startDate: split, endDate: to },
  whole: { startDate: from, endDate: to },
};

async function createFixture(differentTops = false) {
  const fixture = await bookingHarness();
  await fixture.t.run(async (ctx) => {
    const { tenantId } = fixture;
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    const programId = await insertProgram(ctx, tenantId, admin._id, "Program");
    for (const [side, at] of [from + 5 * DAY, split + 4 * DAY].entries()) {
      const customer = await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        programId,
        paidAt: at,
      });
      await ctx.db.patch("leads", customer.leadId, { firstSeenAt: at - (side + 2) * DAY });
      if (side === 0)
        await insertMeeting(ctx, {
          tenantId,
          opportunityId: customer.opportunityId,
          closerId: closer._id,
          scheduledAt: at - 2 * DAY,
        });
      const excluded = await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        recorderId: admin._id,
        assignedCloserId: null,
        programId,
        paidAt: at + DAY,
        withMeeting: false,
      });
      // A negative duration is excluded from the average, giving the
      // windows different sample counts so an unweighted average fails.
      if (side === 0) await ctx.db.patch("leads", excluded.leadId, { firstSeenAt: at + 2 * DAY });
      await insertPerson(ctx, tenantId, { firstSeenAt: at });
      const meetingId = customer.meetingId!;
      for (const [fieldKey, answerText] of [
        ["budget", " Yes "],
        ["budget", "Yes"],
        ["budget", differentTops && side === 1 ? "No" : "Yes"],
        ["budget", differentTops && side === 1 ? "No" : "Yes"],
        ["handle", side === 0 ? "@ana" : "@beto"],
        ["notes", "   "],
      ]) {
        await ctx.db.insert("meetingFormResponses", {
          tenantId,
          meetingId,
          opportunityId: customer.opportunityId,
          leadId: customer.leadId,
          fieldKey,
          questionLabelSnapshot: fieldKey,
          answerText,
          capturedAt: at,
        });
      }
    }
    for (const lead of await ctx.db.query("leads").take(100)) {
      await syncLeadStageEntries(ctx, tenantId, lead._id, null, readLifecycle(lead));
    }
  });
  return fixture;
}

describe("Leads across the split", () => {
  it("adds conversions, recomputes rates and weights time by its actual sample count", async () => {
    const { t } = await createFixture();
    const answers = await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.leadConversion.getLeadConversionMetrics,
      ...windows,
      merge: mergeLeadConversionMetrics,
    });
    expect(answers.history.totalConversions).toBeGreaterThan(0);
    expect(answers.today.totalConversions).toBeGreaterThan(0);
    expect(answers.history.timeToConversionSampleCount).toBe(1);
    expect(answers.today.timeToConversionSampleCount).toBe(2);
    const merged = mergeLeadConversionMetrics(answers.history, answers.today);
    expect(merged.avgTimeToConversionMs).toBeCloseTo(
      (answers.history.avgTimeToConversionMs! * answers.history.timeToConversionSampleCount +
        answers.today.avgTimeToConversionMs! * answers.today.timeToConversionSampleCount) /
        merged.timeToConversionSampleCount,
    );
    const current = {
      ...answers.today,
      isConversionDataTruncated: true,
      byCloser: answers.today.byCloser.map((row) => ({ ...row, closerName: "Current name" })),
    };
    expect(mergeLeadConversionMetrics(answers.history, current)).toMatchObject({
      isConversionDataTruncated: true,
      byCloser: [{ closerName: "Current name", conversions: 2 }],
    });
    expect(
      mergeLeadConversionMetrics(answers.history, { ...current, byCloser: [] }).byCloser,
    ).toEqual([]);
  });

  it("merges form KPIs and selected-field distributions with shared and new answers", async () => {
    const { t } = await createFixture();
    const kpis = await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.formResponseAnalytics.getFormResponseKpis,
      ...windows,
      merge: mergeFormResponseKpis,
    });
    expect(kpis.history.respondedMeetingsCount).toBeGreaterThan(0);
    expect(kpis.today.respondedMeetingsCount).toBeGreaterThan(0);
    expect(
      mergeFormResponseKpis(
        { ...kpis.history, isMeetingsTruncated: true, isFormResponsesTruncated: true },
        kpis.today,
      ),
    ).toMatchObject({ isMeetingsTruncated: true, isFormResponsesTruncated: true });
    for (const fieldKey of ["budget", "handle"]) {
      const answers = await expectMergedAnswer({
        t,
        identity,
        live: api.reporting.formResponseAnalytics.getAnswerDistribution,
        history: { ...windows.history, fieldKey },
        today: { ...windows.today, fieldKey },
        whole: { ...windows.whole, fieldKey },
        merge: mergeAnswerDistribution,
      });
      expect(answers.history.totalResponses).toBeGreaterThan(0);
      expect(answers.today.totalResponses).toBeGreaterThan(0);
      expect(
        mergeAnswerDistribution({ ...answers.history, isTruncated: true }, answers.today)
          .isTruncated,
      ).toBe(true);
    }
  });

  it("chooses among the returned tops when each window hides other answer counts", async () => {
    const { t, admin } = await createFixture(true);
    const whole = await admin.query(
      api.reporting.formResponseAnalytics.getFormResponseKpis,
      windows.whole,
    );
    await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.formResponseAnalytics.getFormResponseKpis,
      ...windows,
      merge: (history, today) => {
        const merged = mergeFormResponseKpis(history, today);
        expect(history.respondedMeetingsCount).toBeGreaterThan(0);
        expect(today.respondedMeetingsCount).toBeGreaterThan(0);
        const budget = merged.topAnswerPerField.find((row) => row.fieldKey === "budget")!;
        // History returns Yes=4, today returns No=2 after the label tie-break.
        // Today's hidden Yes=2 cannot be added to the candidate's known count.
        expect(budget).toMatchObject({ topAnswer: "Yes", topAnswerCount: 4, totalResponses: 8 });
        expect(budget.topAnswerShare).toBeCloseTo(4 / 8);
        expect(
          whole.topAnswerPerField.find((row) => row.fieldKey === "budget")!.topAnswerCount,
        ).toBe(6);
        return {
          ...merged,
          topAnswerPerField: merged.topAnswerPerField.map((row) => {
            const exact = whole.topAnswerPerField.find((field) => field.fieldKey === row.fieldKey)!;
            return {
              ...row,
              topAnswer: exact.topAnswer,
              topAnswerCount: exact.topAnswerCount,
              topAnswerShare: exact.topAnswerShare,
            };
          }),
        };
      },
    });
  });
});
