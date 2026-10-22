/**
 * The labels and the person page read the deal's stage and outcome
 * (docs/plans/phase-5-deal-status.md §6.1): each payload carries the stage,
 * the outcome, the position and the system's loss, and the deal sheet's
 * controls show on the same deals as today.
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { insertLatestMeeting } from "../../tests/dealStageFixtures";
import {
  insertDealEvent,
  insertPerson,
  insertPersonDeal,
  insertReminder,
  insertSideDealPayment,
} from "../../tests/stageLabelFixtures";

const NO_SHOW_LABEL = {
  stage: "closed",
  outcome: "lost",
  position: "lost",
  systemLoss: "no_show",
} as const;

describe("the deal sheet", () => {
  it("carries the deal's stage, outcome, position and the system's loss", async () => {
    const h = await bookingHarness();
    const opportunityId = await h.t.run(async (ctx) =>
      insertPersonDeal(ctx, {
        tenantId: h.tenantId,
        leadId: await insertPerson(ctx, h.tenantId),
        status: "no_show",
      }),
    );
    const detail = await h.admin.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId });
    expect(detail?.opportunity).toMatchObject(NO_SHOW_LABEL);
  });

  it("offers payment, lost and delete on a side deal at Call held, and nothing on a booked deal", async () => {
    const h = await bookingHarness();
    const { sideDeal, booked } = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      return {
        sideDeal: await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "scheduled", source: "side_deal" }),
        booked: await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "scheduled" }),
      };
    });
    const side = await h.admin.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId: sideDeal });
    expect(side?.opportunity.position).toBe("call_held");
    expect(side?.permissions).toMatchObject({
      canRecordPayment: true,
      canMarkLost: true,
      canDeleteOpportunity: true,
      canRecordAdditionalPayment: false,
      canVoidPayment: false,
    });
    const calendly = await h.admin.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId: booked });
    expect(calendly?.opportunity.position).toBe("booked");
    expect(calendly?.permissions).toMatchObject({
      canRecordPayment: false,
      canMarkLost: false,
      canDeleteOpportunity: false,
    });
  });

  it("offers another payment and the void on a won side deal", async () => {
    const h = await bookingHarness();
    const { opportunityId, paymentId } = await h.t.run(async (ctx) => {
      const opportunityId = await insertPersonDeal(ctx, {
        tenantId: h.tenantId,
        leadId: await insertPerson(ctx, h.tenantId),
        status: "payment_received",
        source: "side_deal",
      });
      return { opportunityId, paymentId: await insertSideDealPayment(ctx, opportunityId) };
    });
    const detail = await h.admin.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId });
    expect(detail?.opportunity.position).toBe("won");
    expect(detail?.permissions).toMatchObject({
      canRecordPayment: false,
      canMarkLost: false,
      canRecordAdditionalPayment: true,
      canVoidPayment: true,
      voidablePaymentId: paymentId,
    });
  });

  it("gives each deal event the outcomes a new one records", async () => {
    const h = await bookingHarness();
    const opportunityId = await h.t.run(async (ctx) => {
      const opportunityId = await insertPersonDeal(ctx, {
        tenantId: h.tenantId,
        leadId: await insertPerson(ctx, h.tenantId),
        status: "payment_received",
      });
      await insertDealEvent(ctx, opportunityId, {
        eventType: "opportunity.status_changed",
        occurredAt: 2_000,
        fromStatus: "scheduled",
        toStatus: "payment_received",
      });
      await insertDealEvent(ctx, opportunityId, {
        eventType: "opportunity.stage_changed",
        occurredAt: 3_000,
        fromStatus: "booked",
        toStatus: "closed",
        metadata: { fromOutcome: "open", toOutcome: "won" },
      });
      return opportunityId;
    });
    const detail = await h.admin.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId });
    expect(detail?.events.map(({ eventType, fromStatus, toStatus, fromOutcome, toOutcome }) => ({
      eventType, fromStatus, toStatus, fromOutcome, toOutcome,
    }))).toEqual([
      { eventType: "opportunity.stage_changed", fromStatus: "booked", toStatus: "closed", fromOutcome: "open", toOutcome: "won" },
      { eventType: "opportunity.status_changed", fromStatus: "scheduled", toStatus: "payment_received", fromOutcome: null, toOutcome: null },
    ]);
  });
});

describe("the person page", () => {
  it("labels each deal and each meeting's deal by its position", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      const expired = await insertPersonDeal(ctx, {
        tenantId: h.tenantId, leadId, status: "lost", source: "slack_qualified", createdAt: 1_000,
        fields: { lostReason: "stale", lostAt: 1_500 },
      });
      const noShow = await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "no_show", createdAt: 2_000 });
      const sideDeal = await insertPersonDeal(ctx, {
        tenantId: h.tenantId, leadId, status: "scheduled", source: "side_deal", createdAt: 3_000,
      });
      const meetingId = await insertLatestMeeting(ctx, noShow, { status: "no_show" });
      return { leadId, expired, noShow, sideDeal, meetingId };
    });
    const detail = await h.admin.query(api.leadCustomers.detail.getEntityDetail, { leadId: seeded.leadId });
    if (detail?.kind !== "detail") throw new Error("Expected the person's detail");

    const deals = new Map(detail.opportunities.map((item) => [item.opportunity._id, item]));
    expect(deals.get(seeded.expired)?.opportunity).toMatchObject({
      stage: "closed", outcome: "lost", position: "lost", systemLoss: "stale",
    });
    expect(deals.get(seeded.noShow)?.opportunity).toMatchObject(NO_SHOW_LABEL);
    expect(deals.get(seeded.sideDeal)?.opportunity).toMatchObject({
      stage: "call_held", outcome: "open", position: "call_held", systemLoss: null,
    });
    // Recording a payment from the person page is the side deal's, at Call held.
    expect(
      detail.opportunities.filter((item) => item.permissions.canRecordPayment).map((item) => item.opportunity._id),
    ).toEqual([seeded.sideDeal]);

    expect(detail.meetings).toEqual([
      expect.objectContaining({
        _id: seeded.meetingId,
        dealStage: "closed",
        dealOutcome: "lost",
        dealPosition: "lost",
      }),
    ]);
  });
});

describe("the meeting and reminder pages", () => {
  it("label the deal and each history meeting's deal by its position", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      const noShow = await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "no_show", createdAt: 1_000 });
      const won = await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "payment_received", createdAt: 2_000 });
      return {
        current: await insertLatestMeeting(ctx, noShow, { status: "no_show", scheduledAt: 2_000 }),
        earlier: await insertLatestMeeting(ctx, won, { status: "completed", scheduledAt: 1_000 }),
      };
    });
    const detail = await h.closer.query(api.closer.meetingDetail.getMeetingDetail, { meetingId: seeded.current });
    expect(detail.opportunity).toMatchObject(NO_SHOW_LABEL);
    expect(
      detail.meetingHistory.map(({ _id, dealPosition, dealSystemLoss }) => ({
        _id, dealPosition, dealSystemLoss,
      })),
    ).toEqual([
      { _id: seeded.current, dealPosition: "lost", dealSystemLoss: "no_show" },
      { _id: seeded.earlier, dealPosition: "won", dealSystemLoss: null },
    ]);
  });

  it("label the reminder's deal for the closer and the admin", async () => {
    const h = await bookingHarness();
    const followUpId = await h.t.run(async (ctx) => {
      const opportunityId = await insertPersonDeal(ctx, {
        tenantId: h.tenantId,
        leadId: await insertPerson(ctx, h.tenantId),
        status: "follow_up_scheduled",
      });
      return await insertReminder(ctx, opportunityId);
    });
    const followUp = {
      stage: "follow_up", outcome: "open", position: "follow_up", systemLoss: null,
    };
    const closer = await h.closer.query(api.closer.reminderDetail.getReminderDetail, { followUpId });
    expect(closer?.opportunity).toMatchObject(followUp);
    const admin = await h.admin.query(api.pipeline.reminderDetail.getAdminReminderDetail, { followUpId });
    expect(admin?.opportunity).toMatchObject(followUp);
  });
});
