import { describe, expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { shouldMarkUnresponsive } from "../lib/leadLifecycle";
import {
  awaitsCallResult,
  blocksNewQualification,
  blocksUserRemoval,
  canCancelForUnavailability,
  canMarkLost,
  canRecordMeetingOutcome,
  canSendRescheduleLink,
  canStartFollowUp,
  canTakePayment,
  describeDealState,
  isFollowUpWithoutRescheduleLink,
  isOpenDeal,
  isQualifiedDeal,
  isQualifiedSlackDeal,
  isSideDealAtCallHeld,
  isWonDeal,
  loadDealTasks,
} from "./dealGuards";
import { legacyStatus } from "./dealState";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  disagreements,
  guardCases,
  guardDeal,
  insertGuardDeal,
  insertGuardTask,
  todaysGuards as today,
  type GuardCase,
} from "../../tests/dealGuardFixtures";

// Each guard PR 7 moves reads the stage, the outcome, the loss and the tasks,
// and answers as today's status check does on every deal state
// (docs/plans/phase-5-deal-status.md §4.6).

const cases = guardCases();
const CUTOFF = 5_000;

const openLead = { status: "active", disposition: "open" } as Doc<"leads">;

type Row = [
  name: string,
  newCheck: (guardCase: GuardCase) => boolean,
  oldCheck: (guardCase: GuardCase) => boolean,
];

const rows: Row[] = [
  ["isOpenDeal", (c) => isOpenDeal(c.deal), (c) => today.active(c.status)],
  ["isQualifiedDeal", (c) => isQualifiedDeal(c.deal), (c) => today.qualifiedPending(c.status)],
  ["awaitsCallResult", (c) => awaitsCallResult(c.deal), (c) => today.scheduled(c.status)],
  [
    "isFollowUpWithoutRescheduleLink",
    (c) => isFollowUpWithoutRescheduleLink(c.deal, c.tasks),
    (c) => today.followUpScheduled(c.status),
  ],
  ["isWonDeal", (c) => isWonDeal(c.deal), (c) => today.won(c.status)],
  ["canRecordMeetingOutcome", (c) => canRecordMeetingOutcome(c.deal), (c) => today.scheduled(c.status)],
  ["canTakePayment", (c) => canTakePayment(c.deal, c.tasks), (c) => today.takePayment(c.status)],
  ["canMarkLost", (c) => canMarkLost(c.deal, c.tasks), (c) => today.markLost(c.status)],
  ["canStartFollowUp", (c) => canStartFollowUp(c.deal), (c) => today.startFollowUp(c.status)],
  ["canSendRescheduleLink", (c) => canSendRescheduleLink(c.deal), (c) => today.sendRescheduleLink(c.status)],
  [
    "canCancelForUnavailability",
    (c) => canCancelForUnavailability(c.deal),
    (c) => today.canceledFrom(c.status),
  ],
  ["blocksUserRemoval", (c) => blocksUserRemoval(c.deal), (c) => today.blocksUserRemoval(c.status)],
  [
    "isSideDealAtCallHeld",
    (c) => isSideDealAtCallHeld(c.deal),
    (c) => today.sideDealScheduled(c.status, c.deal.source),
  ],
  [
    "isQualifiedSlackDeal",
    (c) => isQualifiedSlackDeal(c.deal),
    (c) => today.slackQualifiedPending(c.status, c.deal.source),
  ],
  [
    "blocksNewQualification, created after the join cutoff",
    (c) => blocksNewQualification({ ...c.deal, createdAt: CUTOFF + 1 }, CUTOFF),
    (c) => today.blocksNewQualification(c.status, CUTOFF + 1, CUTOFF),
  ],
  [
    "blocksNewQualification, created at the join cutoff",
    (c) => blocksNewQualification({ ...c.deal, createdAt: CUTOFF }, CUTOFF),
    (c) => today.blocksNewQualification(c.status, CUTOFF, CUTOFF),
  ],
  [
    "shouldMarkUnresponsive",
    (c) => shouldMarkUnresponsive(openLead, [c.deal]),
    (c) => !today.active(c.status),
  ],
];

it("runs over the states assertDealStages accepts, the person's losses among them", () => {
  expect(cases.filter((c) => legacyStatus(c.deal, c.tasks) !== c.status).map((c) => c.label)).toEqual([]);
  expect(cases.map((c) => c.label)).toEqual(
    expect.arrayContaining([
      "follow_up_scheduled, calendly",
      "reschedule_link_sent, calendly, a pending reschedule link",
      "no_show, calendly, a pending reschedule link",
      "scheduled, side_deal",
      'lost by a person with the text "no_show"',
      'lost by a person with the text "canceled"',
    ]),
  );
});

describe.each(rows)("%s", (_name, newCheck, oldCheck) => {
  it("agrees with today's status check on every deal state", () => {
    expect(disagreements(cases, newCheck, oldCheck)).toEqual([]);
  });

  it("is true on some deal states and false on others", () => {
    expect(new Set(cases.map(newCheck))).toEqual(new Set([true, false]));
  });
});

describe("shouldMarkUnresponsive", () => {
  it("leaves a person alone while any of their deals is open", () => {
    const deals = [guardDeal("lost", "slack_qualified"), guardDeal("follow_up_scheduled", "calendly")];
    expect(shouldMarkUnresponsive(openLead, deals)).toBe(false);
    expect(shouldMarkUnresponsive(openLead, deals.slice(0, 1))).toBe(true);
  });
});

describe("describeDealState", () => {
  it.each([
    ["scheduled", "calendly", "Booked"],
    ["scheduled", "side_deal", "Call held"],
    ["reschedule_link_sent", "calendly", "Follow-up"],
    ["no_show", "calendly", "Lost: no-show"],
    ["canceled", "slack_qualified", "Lost: canceled"],
    ["payment_received", "calendly", "Won"],
    ["lost", "slack_qualified", "Lost"],
  ] as const)("names a %s %s deal %s", (status, source, label) => {
    expect(describeDealState(guardDeal(status, source))).toBe(label);
  });

  it("names a pair the stage doesn't allow instead of throwing", () => {
    expect(describeDealState(guardDeal("payment_received", "calendly", { fields: { outcome: "open" } }))).toBe(
      "Closed (open)",
    );
  });
});

describe("loadDealTasks", () => {
  it.each([
    ["no task", undefined, false],
    ["a pending reminder", "reminder", false],
    ["a pending ordinary scheduling link", "scheduling_link", false],
    ["a pending reschedule link", "reschedule_link", true],
  ] as const)("reads %s on a Follow-up deal", async (_label, task, hasPendingRescheduleLink) => {
    const harness = await bookingHarness();
    const tasks = await harness.t.run(async (ctx) => {
      const opportunityId = await insertGuardDeal(ctx, harness.tenantId, {
        label: "follow-up",
        status: task === "reschedule_link" ? "reschedule_link_sent" : "follow_up_scheduled",
        source: "calendly",
        task,
      });
      return await loadDealTasks(ctx, opportunityId);
    });
    expect(tasks).toEqual({ hasPendingRescheduleLink });
  });

  it("doesn't count a reschedule link that was booked or expired", async () => {
    const harness = await bookingHarness();
    const tasks = await harness.t.run(async (ctx) => {
      const opportunityId = await insertGuardDeal(ctx, harness.tenantId, {
        label: "follow-up",
        status: "follow_up_scheduled",
        source: "calendly",
      });
      for (const status of ["booked", "expired"] as const) {
        const linkId = await insertGuardTask(ctx, opportunityId, "reschedule_link");
        await ctx.db.patch("followUps", linkId, { status });
      }
      return await loadDealTasks(ctx, opportunityId);
    });
    expect(tasks).toEqual({ hasPendingRescheduleLink: false });
  });
});
