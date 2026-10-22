import { expect } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { pr7ValidateTransition } from "./stageMachineFixtures";
import { isSideDeal } from "../convex/lib/sideDeals";
import { isActiveOpportunityStatus } from "../convex/lib/tenantStatsHelper";
import { insertMeetingAggregate } from "../convex/reporting/writeHooks";
import type { DealTasks } from "../convex/opportunities/dealGuards";
import { legacyStatus, type DealStateFields } from "../convex/opportunities/dealState";
import {
  OPPORTUNITY_STATUSES,
  missedMeetingLossReason,
  stageForStatus,
  type DealSource,
  type OpportunityStatus,
} from "../convex/opportunities/stages";
import { bookingHarness } from "./bookingHarness";
import {
  harnessCloserId,
  insertDeal,
  insertLatestMeeting,
  type DealFields,
} from "./dealStageFixtures";

// PR 7 moves the guards from the status to the stage, the outcome, the loss
// and the tasks (docs/plans/phase-5-deal-status.md §4.6, §6.4, §6.8 to
// §6.10). These fixtures run each guard, old and new, over every state a
// deal can be in.

// ─── Today's checks ───────────────────────────────────────────────────

const PERSON = "user_person" as Id<"users">;

/**
 * Each guard as the code read the status before PR 7, from the line it
 * replaces. The new predicates must give the same answer on every deal.
 */
export const todaysGuards = {
  // lib/outcomeEligibility.ts: assertCanRecordMeetingOutcome; also the
  // unavailability cancel's `pr7ValidateTransition(status, "canceled")`.
  scheduled: (status: OpportunityStatus) => status === "scheduled",
  canceledFrom: (status: OpportunityStatus) => pr7ValidateTransition(status, "canceled"),
  // closer/reminderOutcomes.ts logReminderPayment, sideDeals/logPayment.ts.
  takePayment: (status: OpportunityStatus) => pr7ValidateTransition(status, "payment_received"),
  // closer/meetingActions.ts and admin/meetingActions.ts markAsLost,
  // closer/reminderOutcomes.ts markReminderLost and give_up, sideDeals/markLost.ts.
  markLost: (status: OpportunityStatus) => pr7ValidateTransition(status, "lost"),
  // closer/followUp.ts, closer/followUpMutations.ts, admin/meetingActions.ts.
  startFollowUp: (status: OpportunityStatus) => pr7ValidateTransition(status, "follow_up_scheduled"),
  // The confirm steps' no-op, and the reminder's "schedule a new one".
  followUpScheduled: (status: OpportunityStatus) => status === "follow_up_scheduled",
  // closer/noShowActions.ts and admin/meetingActions.ts reschedule links.
  sendRescheduleLink: (status: OpportunityStatus) =>
    status === "no_show" && pr7ValidateTransition(status, "reschedule_link_sent"),
  // closer/additionalPayment.ts, sideDeals/voidPayment.ts.
  won: (status: OpportunityStatus) => status === "payment_received",
  // lib/leadLifecycle.ts shouldMarkUnresponsive, slack/createQualifiedLead.ts.
  active: (status: OpportunityStatus) => isActiveOpportunityStatus(status),
  qualifiedPending: (status: OpportunityStatus) => status === "qualified_pending",
  // users/queries.ts and workos/userMutations.ts.
  blocksUserRemoval: (status: OpportunityStatus) =>
    (["scheduled", "follow_up_scheduled", "reschedule_link_sent"] as const).some(
      (blocking) => blocking === status,
    ),
  // sideDeals/deleteEmptyOpportunity.ts, opportunities/staleness.ts.
  sideDealScheduled: (status: OpportunityStatus, source: DealSource | undefined) =>
    isSideDeal({ source }) && status === "scheduled",
  // slack/staleExpiry.ts, slack/staleRemindersData.ts.
  slackQualifiedPending: (status: OpportunityStatus, source: DealSource | undefined) =>
    source === "slack_qualified" && status === "qualified_pending",
  // slack/createQualifiedLead.ts: an existing deal that blocks a new one.
  blocksNewQualification: (status: OpportunityStatus, createdAt: number, joinCutoff: number) =>
    isActiveOpportunityStatus(status) &&
    !(status === "qualified_pending" && createdAt <= joinCutoff),
};

// ─── Every deal state, as fields and tasks ───────────────────────────

export const GUARD_SOURCES: readonly (DealSource | undefined)[] = [
  "calendly",
  "slack_qualified",
  "side_deal",
  undefined,
];

export type GuardDeal = DealStateFields & Pick<Doc<"opportunities">, "createdAt">;

export type GuardCase = {
  label: string;
  /** The status the deal stores, which assertDealStages proves is `legacyStatus` of the rest. */
  status: OpportunityStatus;
  deal: GuardDeal;
  tasks: DealTasks;
};

/**
 * A deal's fields at `status` as the dual write leaves them: the mapped
 * stage and outcome, and a missed meeting's loss with no person.
 * `written: false` is a deal from before the widen, with neither.
 */
export function guardDeal(
  status: OpportunityStatus,
  source: DealSource | undefined,
  options: { written?: boolean; fields?: Partial<GuardDeal> } = {},
): GuardDeal {
  const reason = missedMeetingLossReason(status);
  return {
    status,
    source,
    createdAt: 1_000,
    ...(options.written === false ? {} : stageForStatus(status, source)),
    ...(reason ? { lostReason: reason } : {}),
    ...options.fields,
  };
}

/**
 * Every status, on every source, with and without a stored stage, with and
 * without a pending reschedule link, where the pair is one assertDealStages
 * accepts (a Follow-up deal's link decides between `follow_up_scheduled`
 * and `reschedule_link_sent`; any other deal's link changes nothing). Then
 * the losses only the reason and the person tell apart.
 */
export function guardCases(): GuardCase[] {
  const cases: GuardCase[] = [];
  for (const status of OPPORTUNITY_STATUSES) {
    for (const source of GUARD_SOURCES) {
      for (const written of [true, false]) {
        for (const hasPendingRescheduleLink of [false, true]) {
          const deal = guardDeal(status, source, { written });
          const tasks = { hasPendingRescheduleLink };
          if (legacyStatus(deal, tasks) !== status) {
            continue;
          }
          const parts = [
            status,
            source ?? "no source",
            ...(written ? [] : ["no stored stage"]),
            ...(hasPendingRescheduleLink ? ["a pending reschedule link"] : []),
          ];
          cases.push({ label: parts.join(", "), status, deal, tasks });
        }
      }
    }
  }
  const noLink = { hasPendingRescheduleLink: false };
  for (const text of ["no_show", "canceled", "stale"]) {
    cases.push({
      label: `lost by a person with the text "${text}"`,
      status: "lost",
      deal: guardDeal("lost", "calendly", { fields: { lostReason: text, lostByUserId: PERSON } }),
      tasks: noLink,
    });
  }
  cases.push(
    {
      label: "lost by a person with no reason",
      status: "lost",
      deal: guardDeal("lost", "calendly", { fields: { lostByUserId: PERSON } }),
      tasks: noLink,
    },
    {
      label: "lost by the Slack expiry",
      status: "lost",
      deal: guardDeal("lost", "slack_qualified", { fields: { lostReason: "stale" } }),
      tasks: noLink,
    },
    {
      label: "no_show with a stale reschedule link",
      status: "no_show",
      deal: guardDeal("no_show", "calendly"),
      tasks: { hasPendingRescheduleLink: true },
    },
  );
  return cases;
}

/** The cases where `newCheck` and `oldCheck` disagree, by label. */
export function disagreements(
  cases: readonly GuardCase[],
  newCheck: (guardCase: GuardCase) => boolean,
  oldCheck: (guardCase: GuardCase) => boolean,
): string[] {
  return cases
    .filter((guardCase) => newCheck(guardCase) !== oldCheck(guardCase))
    .map((guardCase) => `${guardCase.label}: new ${newCheck(guardCase)}, old ${oldCheck(guardCase)}`);
}

// ─── Deals in a harness, for the write paths ─────────────────────────

export type GuardTask = "reminder" | "scheduling_link" | "reschedule_link";

export type GuardState = {
  label: string;
  status: OpportunityStatus;
  source: DealSource;
  /** A pending task on the deal. */
  task?: GuardTask;
  /** Who recorded a loss, and with what text. */
  personLoss?: { lostReason?: string };
};

/**
 * The states a write runs against: every status, the tasks a Follow-up deal
 * can have (none, a reminder, an ordinary scheduling link, a reschedule
 * link), and a person's loss whose text is a system code.
 */
export function guardStates(source: DealSource = "calendly"): GuardState[] {
  const states: Omit<GuardState, "source">[] = [
    { label: "qualified_pending", status: "qualified_pending" },
    { label: "scheduled", status: "scheduled" },
    { label: "follow_up_scheduled with no task", status: "follow_up_scheduled" },
    { label: "follow_up_scheduled with a pending reminder", status: "follow_up_scheduled", task: "reminder" },
    {
      label: "follow_up_scheduled with a pending scheduling link",
      status: "follow_up_scheduled",
      task: "scheduling_link",
    },
    { label: "reschedule_link_sent", status: "reschedule_link_sent", task: "reschedule_link" },
    { label: "canceled", status: "canceled" },
    { label: "no_show", status: "no_show" },
    { label: "no_show with a stale reschedule link", status: "no_show", task: "reschedule_link" },
    { label: "payment_received", status: "payment_received" },
    { label: "lost", status: "lost", personLoss: { lostReason: "budget" } },
    { label: 'lost by a person with the text "no_show"', status: "lost", personLoss: { lostReason: "no_show" } },
  ];
  return states.map((state) => ({ ...state, source }));
}

/** A pending task on the deal, owned by the harness closer. */
export async function insertGuardTask(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  task: GuardTask,
): Promise<Id<"followUps">> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const base = {
    tenantId: deal.tenantId,
    opportunityId,
    leadId: deal.leadId,
    closerId: await harnessCloserId(ctx),
    status: "pending" as const,
    createdAt: 1_200,
  };
  switch (task) {
    case "reminder":
      return await ctx.db.insert("followUps", {
        ...base,
        type: "manual_reminder",
        reason: "closer_initiated",
        contactMethod: "call",
        reminderScheduledAt: 1_500,
      });
    case "scheduling_link":
      return await ctx.db.insert("followUps", {
        ...base,
        type: "scheduling_link",
        reason: "closer_initiated",
        schedulingLinkUrl: "https://calendly.com/closer/follow-up",
      });
    case "reschedule_link":
      return await ctx.db.insert("followUps", {
        ...base,
        type: "scheduling_link",
        reason: "no_show_follow_up",
        schedulingLinkUrl: "https://calendly.com/closer/reschedule",
      });
  }
}

/** A deal at `state`, assigned to the harness closer, with its task. */
export async function insertGuardDeal(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  state: GuardState,
  fields: DealFields = {},
): Promise<Id<"opportunities">> {
  const closerId = await harnessCloserId(ctx);
  const reason = missedMeetingLossReason(state.status);
  const opportunityId = await insertDeal(ctx, {
    tenantId,
    status: state.status,
    source: state.source,
    fields: {
      assignedCloserId: closerId,
      ...(reason ? { lostReason: reason, lostAt: 1_500 } : {}),
      ...(state.personLoss ? { ...state.personLoss, lostAt: 1_500, lostByUserId: closerId } : {}),
      ...(state.status === "payment_received" ? { paymentReceivedAt: 1_500 } : {}),
      ...fields,
    },
  });
  if (state.task) {
    await insertGuardTask(ctx, opportunityId, state.task);
  }
  return opportunityId;
}

export type GuardHarness = Awaited<ReturnType<typeof guardHarness>>;

/**
 * The booking harness with a program, and a closer whose personal Calendly
 * event type the link actions read.
 */
export async function guardHarness() {
  const harness = await bookingHarness();
  const { closerId, adminId, programId } = await harness.t.run(async (ctx) => {
    const closerId = await harnessCloserId(ctx);
    await ctx.db.patch("users", closerId, { personalEventTypeUri: "https://calendly.com/closer/call" });
    const admin = (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
      .unique())!;
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId: harness.tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      createdByUserId: admin._id,
      updatedAt: 0,
    });
    return { closerId, adminId: admin._id, programId };
  });
  return { ...harness, closerId, adminId, programId };
}

/** A deal at `state` in the harness, with a meeting when the write needs one. */
export async function guardDealIn(
  harness: GuardHarness,
  state: GuardState,
  options: { meeting?: Doc<"meetings">["status"]; fields?: DealFields } = {},
): Promise<{ opportunityId: Id<"opportunities">; meetingId: Id<"meetings"> | null }> {
  return await harness.t.run(async (ctx) => {
    const opportunityId = await insertGuardDeal(ctx, harness.tenantId, state, options.fields);
    if (!options.meeting) {
      return { opportunityId, meetingId: null };
    }
    const meetingId = await insertLatestMeeting(ctx, opportunityId, { status: options.meeting });
    await insertMeetingAggregate(ctx, meetingId);
    return { opportunityId, meetingId };
  });
}

/** A pending reminder of the harness closer on the deal, for the reminder pages. */
export async function reminderOn(
  harness: GuardHarness,
  opportunityId: Id<"opportunities">,
): Promise<Id<"followUps">> {
  return await harness.t.run((ctx) => insertGuardTask(ctx, opportunityId, "reminder"));
}

export async function readGuardDeal(
  harness: GuardHarness,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  return (await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId)))!;
}

/**
 * The write goes through when the guard allows it, and is refused, leaving
 * the deal's status as it was, when it doesn't.
 */
export async function expectGuard(
  harness: GuardHarness,
  opportunityId: Id<"opportunities">,
  write: () => Promise<unknown>,
  allowed: boolean,
): Promise<void> {
  const before = await readGuardDeal(harness, opportunityId);
  if (allowed) {
    await write();
    return;
  }
  await expect(write()).rejects.toThrow();
  // A refused write leaves every field the guards read as it was.
  const guarded = (deal: typeof before) => ({
    status: deal.status,
    stage: deal.stage,
    outcome: deal.outcome,
    lostReason: deal.lostReason,
    lostByUserId: deal.lostByUserId,
  });
  expect(guarded(await readGuardDeal(harness, opportunityId))).toEqual(guarded(before));
}
