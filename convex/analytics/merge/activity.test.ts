import { describe, expect, it } from "vitest";
import { bookingHarness } from "../../../tests/bookingHarness";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { fixtureUsers } from "../../../tests/enrollmentReadFixtures";
import { api } from "../../_generated/api";
import { insertActivityEventCounts } from "../../reporting/activityEventCounts";
import { mergeActivitySummary } from "./activity";

const from = Date.parse("2026-10-01T06:00:00Z");
const split = Date.parse("2026-10-17T06:00:00Z");
const to = Date.parse("2026-11-01T06:00:00Z");
const identity = { subject: "user_admin", org_id: "org_test" };

for (const aggregated of [false, true]) {
  describe(`Activity across the split, aggregate=${aggregated}`, () => {
    it("adds all dimensions, outcomes and actors, including a removed actor", async () => {
      const { t, tenantId } = await bookingHarness();
      await t.run(async (ctx) => {
        const { admin, closer } = await fixtureUsers(ctx, tenantId);
        if (aggregated)
          await ctx.db.patch("tenants", tenantId, { activityEventCountsVerifiedAt: 0 });
        const removed = await ctx.db.insert("users", {
          tenantId,
          workosUserId: "gone",
          email: "gone@example.invalid",
          role: "closer",
          isActive: false,
        });
        for (const occurredAt of [from, split]) {
          for (let index = 0; index < 7; index += 1) {
            const id = await ctx.db.insert("domainEvents", {
              tenantId,
              occurredAt: occurredAt + index,
              entityType: index < 4 ? "followUp" : "payment",
              entityId: "fixture",
              eventType: index < 4 ? "followUp.completed" : "payment.recorded",
              source: index < 4 ? "closer" : "admin",
              actorUserId: index < 4 ? closer._id : index < 6 ? admin._id : removed,
              metadata: JSON.stringify({ outcome: "payment_received" }),
            });
            await insertActivityEventCounts(ctx, (await ctx.db.get("domainEvents", id))!);
          }
          const id = await ctx.db.insert("domainEvents", {
            tenantId,
            occurredAt: occurredAt + 10,
            entityType: "opportunity",
            entityId: "fixture",
            eventType: "opportunity.stale_flagged",
            source: "system",
          });
          await insertActivityEventCounts(ctx, (await ctx.db.get("domainEvents", id))!);
        }
        await ctx.db.delete("users", removed);
      });
      const answers = await expectMergedAnswer({
        t,
        identity,
        live: api.reporting.activityFeed.getActivitySummary,
        history: { startDate: from, endDate: split },
        today: { startDate: split, endDate: to },
        whole: { startDate: from, endDate: to },
        merge: mergeActivitySummary,
      });
      expect(answers.history.totalEvents).toBe(8);
      expect(answers.today.totalEvents).toBe(8);
      expect(answers.whole.byOutcome.reminder_payment_received).toBe(8);
      const current = {
        ...answers.today,
        isTruncated: true,
        actorBreakdown: answers.today.actorBreakdown.map((actor) => ({
          ...actor,
          actorName: "Current name",
        })),
      };
      const merged = mergeActivitySummary(answers.history, current);
      expect(merged.isTruncated).toBe(true);
      expect(merged.actorBreakdown.every((actor) => actor.actorName === "Current name")).toBe(true);
    });
  });
}
