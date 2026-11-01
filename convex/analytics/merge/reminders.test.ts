import { describe, expect, it } from "vitest";
import { bookingHarness, qualifiedLifecycle } from "../../../tests/bookingHarness";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { fixtureUsers, insertProgram } from "../../../tests/enrollmentReadFixtures";
import { api } from "../../_generated/api";
import { mergeReminderOutcomeFunnel } from "./reminders";

const from = Date.parse("2026-09-01T06:00:00Z");
const split = Date.parse("2026-09-17T06:00:00Z");
const to = Date.parse("2026-10-01T06:00:00Z");
const identity = { subject: "user_admin", org_id: "org_test" };
const windows = {
  history: { startDate: from, endDate: split },
  today: { startDate: split, endDate: to },
  whole: { startDate: from, endDate: to },
};

async function createFixture(sharedChain = false) {
  const fixture = await bookingHarness();
  const programId = await fixture.t.run(async (ctx) => {
    const { tenantId } = fixture;
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    const programId = await insertProgram(ctx, tenantId, admin._id, "Program");
    const otherProgramId = await insertProgram(ctx, tenantId, admin._id, "Other");
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...qualifiedLifecycle(from),
      status: "active",
      firstSeenAt: from,
      updatedAt: from,
    });
    const shared = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      stage: "follow_up",
      outcome: "open",
      createdAt: from,
      updatedAt: from,
    });
    for (const at of [from, split]) {
      const opportunityId = sharedChain
        ? shared
        : await ctx.db.insert("opportunities", {
            tenantId,
            leadId,
            stage: "follow_up",
            outcome: "open",
            createdAt: at,
            updatedAt: at,
          });
      const outcomes = [
        "payment_received",
        "lost",
        "no_response_rescheduled",
        "no_response_given_up",
        "no_response_close_only",
        undefined,
      ] as const;
      const windowOutcomes = sharedChain ? outcomes.slice(0, at === from ? 2 : 3) : outcomes;
      for (const [index, completionOutcome] of windowOutcomes.entries()) {
        await ctx.db.insert("followUps", {
          tenantId,
          leadId,
          opportunityId,
          closerId: index % 2 ? admin._id : closer._id,
          type: "manual_reminder",
          reason: "closer_initiated",
          status: "completed",
          completionOutcome,
          createdAt: at + index,
        });
      }
      await ctx.db.insert("followUps", {
        tenantId,
        leadId,
        opportunityId,
        closerId: closer._id,
        type: "scheduling_link",
        reason: "no_show_follow_up",
        status: "pending",
        createdAt: at + 10,
      });
      for (const [index, paymentType] of (["pif", "deposit", "split"] as const).entries()) {
        await ctx.db.insert("paymentRecords", {
          tenantId,
          opportunityId,
          amountMinor: 100_000 + index,
          currency: "USD",
          recordedByUserId: admin._id,
          programId: index === 2 ? otherProgramId : programId,
          programName: "Program",
          paymentType,
          status: "verified",
          origin: index % 2 ? "admin_reminder" : "closer_reminder",
          recordedAt: at + index,
        });
      }
    }
    return programId;
  });
  return { ...fixture, programId };
}

describe("Reminders across the split", () => {
  it("merges the funnel, revenue and disjoint chains with every page filter", async () => {
    const { t, programId } = await createFixture();
    for (const filters of [
      {},
      { programId },
      { paymentType: "deposit" as const },
      { programId, paymentType: "pif" as const },
    ]) {
      const answers = await expectMergedAnswer({
        t,
        identity,
        live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
        history: { ...windows.history, ...filters },
        today: { ...windows.today, ...filters },
        whole: { ...windows.whole, ...filters },
        merge: mergeReminderOutcomeFunnel,
      });
      expect(answers.history.totalCreated).toBeGreaterThan(0);
      expect(answers.today.totalCreated).toBeGreaterThan(0);
      expect(answers.history.reminderDrivenPaymentCount).toBeGreaterThan(0);
      expect(answers.today.reminderDrivenPaymentCount).toBeGreaterThan(0);
      expect(
        mergeReminderOutcomeFunnel(
          { ...answers.history, isTruncated: true, isReminderRevenueTruncated: true },
          answers.today,
        ),
      ).toMatchObject({ isTruncated: true, isReminderRevenueTruncated: true });
    }
  });

  it("documents the distinct-chain and histogram approximation for a deal in both windows", async () => {
    const { t, admin } = await createFixture(true);
    const whole = await admin.query(
      api.reporting.remindersReporting.getReminderOutcomeFunnel,
      windows.whole,
    );
    await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
      ...windows,
      merge: (history, today) => {
        const merged = mergeReminderOutcomeFunnel(history, today);
        expect(history.totalCreated).toBeGreaterThan(0);
        expect(today.totalCreated).toBeGreaterThan(0);
        expect(merged.opportunitiesWithReminderChains).toBe(
          history.opportunitiesWithReminderChains + today.opportunitiesWithReminderChains,
        );
        expect(merged.opportunitiesWithReminderChains).toBe(2);
        expect(whole.opportunitiesWithReminderChains).toBe(1);
        expect(merged.chainLengthHistogram.filter((row) => row.count > 0)).toEqual([
          { bucket: "2", count: 1 },
          { bucket: "3", count: 1 },
        ]);
        expect(whole.chainLengthHistogram.filter((row) => row.count > 0)).toEqual([
          { bucket: "5+", count: 1 },
        ]);
        expect(merged.chainLengthHistogram).toEqual(
          today.chainLengthHistogram.map((row) => ({
            ...row,
            count:
              row.count +
              history.chainLengthHistogram.find((past) => past.bucket === row.bucket)!.count,
          })),
        );
        // Compare every exact field through the shared helper.
        return {
          ...merged,
          opportunitiesWithReminderChains: whole.opportunitiesWithReminderChains,
          chainLengthHistogram: whole.chainLengthHistogram,
        };
      },
    });
  });
});
