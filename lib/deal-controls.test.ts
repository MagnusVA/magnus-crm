/**
 * The meeting and reminder pages show their controls from the deal's
 * position, the system's loss and its reschedule link, on the same deals
 * today's status shows them on (docs/plans/phase-5-deal-status.md §4.6,
 * §6.4). No status changes its result.
 */
import { describe, expect, it } from "vitest";
import { MEETING_STATUSES } from "@/convex/lib/statusTransitions";
import { namesWhere, pageControlCases, TODAY } from "@/tests/pageControlFixtures";
import {
  adminMeetingActions,
  isAwaitingOutcome,
  isClosedByNoShow,
  isDealWon,
  isReminderDealFinished,
  isWaitingOnRescheduleLink,
} from "./deal-controls";

const cases = pageControlCases();

describe("the cases", () => {
  it("cover every status, with and without a pending reschedule link where the status allows one", () => {
    expect(new Set(cases.map((item) => item.status)).size).toBe(8);
    expect(cases.some((item) => item.status === "scheduled" && item.deal.rescheduleLinkPending)).toBe(true);
    expect(cases.some((item) => item.deal.position === "call_held")).toBe(true);
  });
});

describe("the meeting pages", () => {
  it.each([
    ["Deal Won, on Closed won", isDealWon, TODAY.dealWon],
    ["the closer's outcome actions, on Booked or Call held", isAwaitingOutcome, TODAY.awaitingOutcome],
    ["the no-show bar and no outcome bar, on a deal a no-show closed", isClosedByNoShow, TODAY.closedByNoShow],
    [
      "the reschedule link sent banner, on Follow-up with a pending reschedule link",
      isWaitingOnRescheduleLink,
      TODAY.waitingOnRescheduleLink,
    ],
  ] as const)("show %s, the deals today's status shows it on", (_control, shows, today) => {
    expect(namesWhere(cases, (item) => shows(item.deal))).toEqual(
      namesWhere(cases, (item) => today(item.status)),
    );
  });

  it.each(MEETING_STATUSES)("give the admin's bar the actions today's status gives, for a %s meeting", (meetingStatus) => {
    const actual = cases.map((item) => [item.name, adminMeetingActions(item.deal, meetingStatus)]);
    const expected = cases.map((item) => [item.name, TODAY.adminMeetingActions(item.status, meetingStatus)]);
    expect(actual).toEqual(expected);
  });

  it("give the admin no bar on a closed deal, except one a missed meeting closed", () => {
    const shown = (position: "won" | "lost", systemLoss: "no_show" | "canceled" | "stale" | null) =>
      adminMeetingActions({ position, systemLoss }, "scheduled");
    expect(shown("won", null)).toBeNull();
    expect(shown("lost", null)).toBeNull();
    expect(shown("lost", "stale")).toBeNull();
    expect(shown("lost", "canceled")).toEqual({ outcome: false, scheduleFollowUp: true, rescheduleLink: false });
    expect(shown("lost", "no_show")).toEqual({ outcome: false, scheduleFollowUp: true, rescheduleLink: true });
  });
});

describe("the reminder pages", () => {
  it("count a deal as finished when it is Closed, except one a cancellation closed, as today", () => {
    expect(namesWhere(cases, (item) => isReminderDealFinished(item.deal))).toEqual(
      namesWhere(cases, (item) => TODAY.reminderDealFinished(item.status)),
    );
  });

  it("keep the outcome buttons on a deal a cancellation closed, and not on one a no-show closed", () => {
    expect(isReminderDealFinished({ position: "lost", systemLoss: "canceled" })).toBe(false);
    expect(isReminderDealFinished({ position: "lost", systemLoss: "no_show" })).toBe(true);
    expect(isReminderDealFinished({ position: "lost", systemLoss: "stale" })).toBe(true);
    expect(isReminderDealFinished({ position: "lost", systemLoss: null })).toBe(true);
  });
});
