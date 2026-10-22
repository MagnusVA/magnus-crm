import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { writtenBesideStatus } from "../../tests/bookingRuleFixtures";
import { namedStatus } from "../../tests/stopStatusFixtures";

afterEach(() => vi.useRealTimers());

// The 14-day reschedule heuristic used to run before the Slack join, so a
// fresh qualification lost the booking to an old canceled or no-show deal.
// The heuristic is gone (a missed meeting ends the deal); the Slack join
// still takes the booking, and the old deal is left alone.
it.each(["canceled", "no_show"] as const)(
  "joins a booking to a fresh Slack qualification ahead of a recent %s deal",
  async (oldStatus) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const { t, tenantId } = await bookingHarness();
    const { oldOpportunityId, slackOpportunityId } = await t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(Date.parse("2026-09-20T08:00:00Z")),
        tenantId,
        email: "lead@example.com",
        status: "active",
        firstSeenAt: Date.parse("2026-09-20T08:00:00Z"),
        updatedAt: Date.parse("2026-09-28T09:00:00Z"),
      });
      const oldOpportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        source: "calendly",
        ...writtenBesideStatus(oldStatus, "calendly", Date.parse("2026-09-25T09:00:00Z")),
        createdAt: Date.parse("2026-09-20T08:00:00Z"),
        updatedAt: Date.parse("2026-09-25T09:00:00Z"),
      });
      const slackOpportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        source: "slack_qualified",
        ...writtenBesideStatus("qualified_pending", "slack_qualified"),
        qualifiedBy: {
          slackUserId: "U1",
          slackTeamId: "T1",
          submittedAt: Date.parse("2026-09-30T09:00:00Z"),
        },
        createdAt: Date.parse("2026-09-30T09:00:00Z"),
        updatedAt: Date.parse("2026-09-30T09:00:00Z"),
      });
      await insertOpportunityAggregate(ctx, oldOpportunityId);
      await insertOpportunityAggregate(ctx, slackOpportunityId);
      return { oldOpportunityId, slackOpportunityId };
    });

    const payload = bookingPayload("after-qualification");
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: "2026-10-01T10:00:00Z", payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const result = await t.run(async (ctx) => ({
      old: await namedStatus(ctx, oldOpportunityId),
      slack: await namedStatus(ctx, slackOpportunityId),
      meetings: await ctx.db.query("meetings").take(5),
    }));
    expect(result.slack).toBe("scheduled");
    expect(result.old).toBe(oldStatus);
    expect(result.meetings.map((meeting) => meeting.opportunityId)).toEqual([
      slackOpportunityId,
    ]);
  },
);

// This used to reuse the recent canceled deal (the 14-day reschedule join).
// A cancellation ends the deal now, so the booking starts a new one.
it("makes a new deal beside a recent canceled deal when there is no Slack qualification", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId } = await bookingHarness();
  const oldOpportunityId = await t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(Date.parse("2026-09-20T08:00:00Z")),
      tenantId,
      email: "lead@example.com",
      status: "active",
      firstSeenAt: Date.parse("2026-09-20T08:00:00Z"),
      updatedAt: Date.parse("2026-09-28T09:00:00Z"),
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      source: "calendly",
      ...writtenBesideStatus("canceled", "calendly", Date.parse("2026-09-25T09:00:00Z")),
      createdAt: Date.parse("2026-09-20T08:00:00Z"),
      updatedAt: Date.parse("2026-09-25T09:00:00Z"),
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    return opportunityId;
  });

  const payload = bookingPayload("rebook");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-10-01T10:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const meetings = await t.run((ctx) => ctx.db.query("meetings").take(5));
  expect(meetings).toHaveLength(1);
  expect(meetings[0].opportunityId).not.toBe(oldOpportunityId);
  expect(await t.run((ctx) => ctx.db.get("opportunities", meetings[0].opportunityId))).toMatchObject({
    stage: "booked",
    outcome: "open",
    source: "calendly",
  });
  expect(await t.run((ctx) => ctx.db.get("opportunities", oldOpportunityId))).toMatchObject({
    stage: "closed",
    outcome: "lost",
    lostReason: "canceled",
    updatedAt: Date.parse("2026-09-25T09:00:00Z"),
  });
});
