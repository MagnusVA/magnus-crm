/**
 * The meeting page's controls read the deal from its payload: the position,
 * the system's loss, and whether a reschedule link is pending
 * (docs/plans/phase-5-deal-status.md §4.5, §6.4). Read from a real payload,
 * they show on the deals today's status shows them on.
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "../lib/statusTransitions";
import {
  adminMeetingActions,
  isAwaitingOutcome,
  isClosedByNoShow,
  isDealWon,
  isWaitingOnRescheduleLink,
} from "../../lib/deal-controls";
import { bookingHarness } from "../../tests/bookingHarness";
import { insertMeetingPageDeal, TODAY, type MeetingPageTask } from "../../tests/pageControlFixtures";
import { insertPerson } from "../../tests/stageLabelFixtures";

async function meetingDealOf(status: OpportunityStatus, tasks?: MeetingPageTask[]) {
  const h = await bookingHarness();
  const { meetingId } = await h.t.run(async (ctx) =>
    insertMeetingPageDeal(ctx, {
      tenantId: h.tenantId,
      leadId: await insertPerson(ctx, h.tenantId),
      status,
      tasks,
    }),
  );
  return { h, meetingId };
}

describe("the meeting page's reschedule link", () => {
  it("is pending on a Follow-up deal a reschedule link reopened, for the closer and the admin", async () => {
    const { h, meetingId } = await meetingDealOf("reschedule_link_sent");
    const closer = await h.closer.query(api.closer.meetingDetail.getMeetingDetail, { meetingId });
    expect(closer.opportunity).toMatchObject({ position: "follow_up", rescheduleLinkPending: true });
    const admin = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, { meetingId });
    expect(admin.opportunity.rescheduleLinkPending).toBe(true);
  });

  it.each([
    ["no task", []],
    ["an ordinary scheduling link", ["scheduling_link"]],
    ["a reminder", ["reminder"]],
    ["a reschedule link no longer pending", ["expired_reschedule_link"]],
  ] as const)("isn't pending on a Follow-up deal with %s", async (_label, tasks) => {
    const { h, meetingId } = await meetingDealOf("follow_up_scheduled", [...tasks]);
    const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, { meetingId });
    expect(detail.opportunity).toMatchObject({ position: "follow_up", rescheduleLinkPending: false });
  });

  it("is read at any stage, and the banner shows only on Follow-up", async () => {
    const { h, meetingId } = await meetingDealOf("scheduled", ["reschedule_link"]);
    const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, { meetingId });
    expect(detail.opportunity).toMatchObject({ position: "booked", rescheduleLinkPending: true });
    expect(isWaitingOnRescheduleLink(detail.opportunity)).toBe(false);
  });
});

describe("the meeting page's controls, read from the payload", () => {
  it("show on the deals today's status shows them on, for each of today's statuses", async () => {
    const h = await bookingHarness();
    const meetings = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      const byStatus: [OpportunityStatus, Id<"meetings">][] = [];
      for (const [index, status] of OPPORTUNITY_STATUSES.entries()) {
        const { meetingId } = await insertMeetingPageDeal(ctx, {
          tenantId: h.tenantId,
          leadId,
          status,
          createdAt: 1_000 * (index + 1),
        });
        byStatus.push([status, meetingId]);
      }
      return byStatus;
    });

    for (const [status, meetingId] of meetings) {
      const { opportunity, meeting } = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, {
        meetingId,
      });
      expect(opportunity.status).toBe(status);
      expect({
        status,
        dealWon: isDealWon(opportunity),
        awaitingOutcome: isAwaitingOutcome(opportunity),
        closedByNoShow: isClosedByNoShow(opportunity),
        waitingOnRescheduleLink: isWaitingOnRescheduleLink(opportunity),
        adminMeetingActions: adminMeetingActions(opportunity, meeting.status),
      }).toEqual({
        status,
        dealWon: TODAY.dealWon(status),
        awaitingOutcome: TODAY.awaitingOutcome(status),
        closedByNoShow: TODAY.closedByNoShow(status),
        waitingOnRescheduleLink: TODAY.waitingOnRescheduleLink(status),
        adminMeetingActions: TODAY.adminMeetingActions(status, meeting.status),
      });
    }
  });
});
