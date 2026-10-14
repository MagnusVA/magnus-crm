import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { insertLeadAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

// The 14-day reschedule heuristic used to run before the Slack join, so a
// fresh qualification lost the booking to an old canceled or no-show deal.
it.each(["canceled", "no_show"] as const)(
  "joins a booking to a fresh Slack qualification ahead of a recent %s deal",
  async (oldStatus) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const { t, tenantId } = await bookingHarness();
    const { oldOpportunityId, slackOpportunityId } = await t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", {
        tenantId,
        email: "lead@example.com",
        status: "active",
        firstSeenAt: Date.parse("2026-09-20T08:00:00Z"),
        updatedAt: Date.parse("2026-09-28T09:00:00Z"),
      });
      await insertLeadAggregate(ctx, leadId);
      const oldOpportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        status: oldStatus,
        source: "calendly",
        createdAt: Date.parse("2026-09-20T08:00:00Z"),
        updatedAt: Date.parse("2026-09-25T09:00:00Z"),
      });
      const slackOpportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        status: "qualified_pending",
        source: "slack_qualified",
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
      old: await ctx.db.get("opportunities", oldOpportunityId),
      slack: await ctx.db.get("opportunities", slackOpportunityId),
      meetings: await ctx.db.query("meetings").take(5),
    }));
    expect(result.slack?.status).toBe("scheduled");
    expect(result.old?.status).toBe(oldStatus);
    expect(result.meetings.map((meeting) => meeting.opportunityId)).toEqual([
      slackOpportunityId,
    ]);
  },
);

it("still reuses a recent canceled deal when there is no Slack qualification", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId } = await bookingHarness();
  const oldOpportunityId = await t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      email: "lead@example.com",
      status: "active",
      firstSeenAt: Date.parse("2026-09-20T08:00:00Z"),
      updatedAt: Date.parse("2026-09-28T09:00:00Z"),
    });
    await insertLeadAggregate(ctx, leadId);
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "canceled",
      source: "calendly",
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
  expect(meetings.map((meeting) => meeting.opportunityId)).toEqual([oldOpportunityId]);
});
