import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { MeetingStatus } from "../convex/lib/statusTransitions";
import { legacyStatus } from "../convex/opportunities/dealState";
import { dealLabelOf } from "../convex/opportunities/stageLabels";
import {
  OPPORTUNITY_STATUSES,
  type DealSource,
  type OpportunityStatus,
} from "../convex/opportunities/stages";
import { insertLatestMeeting } from "./dealStageFixtures";
import { dealAt, insertDealTask, type DealStateShape } from "./dealStateFixtures";
import { insertPersonDeal } from "./stageLabelFixtures";

// Phase 5 page controls (docs/plans/phase-5-deal-status.md §4.6, §6.4): the
// meeting and reminder pages read the deal's position, the system's loss and
// its reschedule link, and show the controls today's status shows.

// ─── Today's conditions ───────────────────────────────────────────────

const REMINDER_TERMINAL_STATUSES: readonly OpportunityStatus[] = ["payment_received", "lost", "no_show"];

/** What each page showed from `opportunities.status` before PR 7, the record the new checks match. */
export const TODAY = {
  /** The "Deal Won" button and card, with payments (closer and admin meeting pages). */
  dealWon: (status: OpportunityStatus) => status === "payment_received",
  /** The deal half of the closer's outcome actions (`canRecordScheduledOutcome`). */
  awaitingOutcome: (status: OpportunityStatus) => status === "scheduled",
  /** The closer's outcome bar hides, and the no-show bar shows. */
  closedByNoShow: (status: OpportunityStatus) => status === "no_show",
  /** The "reschedule link sent" banner (closer and admin meeting pages). */
  waitingOnRescheduleLink: (status: OpportunityStatus) => status === "reschedule_link_sent",
  /** The admin meeting bar: none on a won or lost deal, else its three groups. */
  adminMeetingActions: (status: OpportunityStatus, meetingStatus: MeetingStatus) =>
    status === "payment_received" || status === "lost"
      ? null
      : {
          outcome: meetingStatus === "scheduled" && status === "scheduled",
          scheduleFollowUp: status === "no_show" || status === "canceled",
          rescheduleLink: status === "no_show",
        },
  /** The reminder pages' "already finished" notice instead of the outcome buttons. */
  reminderDealFinished: (status: OpportunityStatus) => REMINDER_TERMINAL_STATUSES.includes(status),
};

// ─── Deals as production holds them ───────────────────────────────────

/** The deal fields the pages read, as the meeting detail payload carries them. */
export type PageDeal = Pick<ReturnType<typeof dealLabelOf>, "position" | "systemLoss"> & {
  rescheduleLinkPending: boolean;
};

export type PageControlCase = {
  /** The case in a failure diff. */
  name: string;
  /** Today's status, which the old conditions read. */
  status: OpportunityStatus;
  deal: PageDeal;
};

const SOURCES: (DealSource | undefined)[] = ["calendly", "slack_qualified", "side_deal", undefined];

const PERSON = "user" as Id<"users">;

// The losses a deal at `lost` can carry: none, the Slack expiry, and a
// person's, whose free text can match a system code.
const LOST_VARIANTS: { name: string; fields: Partial<DealStateShape> }[] = [
  { name: "no reason", fields: {} },
  { name: "stale", fields: { lostReason: "stale" } },
  { name: "person's reason", fields: { lostReason: "budget", lostByUserId: PERSON } },
  { name: "person's no_show text", fields: { lostReason: "no_show", lostByUserId: PERSON } },
  { name: "person's canceled text", fields: { lostReason: "canceled", lostByUserId: PERSON } },
];

// A pending reschedule link is what makes a Follow-up deal
// `reschedule_link_sent`; at any other stage the status ignores it.
function linkStates(status: OpportunityStatus): boolean[] {
  switch (status) {
    case "follow_up_scheduled":
      return [false];
    case "reschedule_link_sent":
      return [true];
    default:
      return [false, true];
  }
}

/**
 * Every deal shape production can hold for each of today's eight statuses:
 * each source, each kind of loss, and a pending reschedule link wherever the
 * status allows one. Each case's fields rebuild its status (§4.6).
 */
export function pageControlCases(): PageControlCase[] {
  return OPPORTUNITY_STATUSES.flatMap((status) =>
    SOURCES.flatMap((source) =>
      (status === "lost" ? LOST_VARIANTS : [{ name: "", fields: {} }]).flatMap((variant) =>
        linkStates(status).map((rescheduleLinkPending) => {
          const shape = dealAt(status, source, { fields: variant.fields });
          const rebuilt = legacyStatus(shape, { hasPendingRescheduleLink: rescheduleLinkPending });
          const name = [
            status,
            source ?? "no source",
            variant.name,
            rescheduleLinkPending ? "pending reschedule link" : "",
          ]
            .filter(Boolean)
            .join(", ");
          if (rebuilt !== status) {
            throw new Error(`Case "${name}" rebuilds ${rebuilt}, not ${status}`);
          }
          const { position, systemLoss } = dealLabelOf(shape);
          return { name, status, deal: { position, systemLoss, rescheduleLinkPending } };
        }),
      ),
    ),
  );
}

/** The cases `check` picks, by name, for a diff against the cases today's condition picks. */
export function namesWhere(cases: PageControlCase[], check: (item: PageControlCase) => boolean): string[] {
  return cases.filter(check).map((item) => item.name);
}

// ─── The meeting page's payload ───────────────────────────────────────

export type MeetingPageTask = "reschedule_link" | "expired_reschedule_link" | "scheduling_link" | "reminder";

/** The meeting attendance each status leaves on the deal's current meeting. */
const MEETING_STATUS_FOR: Record<OpportunityStatus, MeetingStatus> = {
  qualified_pending: "scheduled",
  scheduled: "scheduled",
  follow_up_scheduled: "held",
  reschedule_link_sent: "no_show",
  payment_received: "held",
  lost: "held",
  canceled: "canceled",
  no_show: "no_show",
};

/**
 * A deal at `status` on the person, with its current meeting and, by
 * default, the task its status implies: a pending reschedule link for
 * `reschedule_link_sent`, none otherwise.
 */
export async function insertMeetingPageDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    status: OpportunityStatus;
    tasks?: MeetingPageTask[];
    createdAt?: number;
  },
): Promise<{ opportunityId: Id<"opportunities">; meetingId: Id<"meetings"> }> {
  const opportunityId = await insertPersonDeal(ctx, {
    tenantId: args.tenantId,
    leadId: args.leadId,
    status: args.status,
    createdAt: args.createdAt,
  });
  const meetingId = await insertLatestMeeting(ctx, opportunityId, {
    status: MEETING_STATUS_FOR[args.status],
    scheduledAt: args.createdAt ?? 2_000,
  });
  const tasks = args.tasks ?? (args.status === "reschedule_link_sent" ? ["reschedule_link"] : []);
  for (const task of tasks) {
    await insertDealTask(ctx, opportunityId, TASK_FIELDS[task]);
  }
  return { opportunityId, meetingId };
}

const TASK_FIELDS: Record<MeetingPageTask, Partial<Pick<Doc<"followUps">, "type" | "reason" | "status">>> = {
  reschedule_link: {},
  expired_reschedule_link: { status: "expired" },
  scheduling_link: { reason: "closer_initiated" },
  reminder: { type: "manual_reminder", reason: "closer_initiated" },
};
