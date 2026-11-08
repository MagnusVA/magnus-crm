"use client";

import { format } from "date-fns";
import { getMemberDisplayName, type MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { StatusWord, type StatusTone } from "@/app/workspace/reports/_components/report-ui";
import { dealEventOutcomes, dealEventStateLabel } from "@/convex/opportunities/stageLabels";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";
import { meetingEventStatusLabel, meetingStatusConfig } from "@/lib/status-config";
import { cn } from "@/lib/utils";

// One event as a ruled row (the Missed meetings rows' grammar): from
// @3xl/feed one 44px line, WHEN · WHO · WHAT · RECORD · STATUS; narrower two
// lines, who and what with the status word, then when · record in slate.
// The status word is coloured by meaning (rule 6); labels may come from
// status-config, its colours never do.

/** WHEN · WHO · WHAT · RECORD · STATUS. */
export const FEED_COLUMNS =
  "@3xl/feed:grid @3xl/feed:grid-cols-[7.5rem_minmax(0,0.85fr)_minmax(0,1.25fr)_minmax(0,1.4fr)_7rem] @3xl/feed:gap-3";

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
};

const ENTITY_LABELS: Record<string, string> = {
  customer: "Customer",
  enrollment: "Enrollment",
  followUp: "Follow-up",
  lead: "Lead",
  meeting: "Meeting",
  opportunity: "Deal",
  payment: "Payment",
  user: "Team member",
  slackInstallation: "Slack",
};

interface PaymentMetadata {
  programId: string | null;
  programName: string | null;
  paymentType: string;
  attributedCloserId: string | null;
}

export interface ActivityEvent {
  _id: string;
  eventType: string;
  entityType: string;
  actorName: string | null;
  actor: MemberAvatarIdentity | null;
  occurredAt: number;
  source: string;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  metadata: Record<string, unknown> | null;
  paymentMetadata?: PaymentMetadata | null;
}

// A status a record moved to, by what it means for the team.
const FAILED_STATUSES = new Set(["lost", "no_show", "churned", "expired", "disputed", "voided", "deactivated", "blocked", "unpaid"]);
const OWED_STATUSES = new Set(["paused", "pending", "qualified_pending", "reschedule_link_sent", "not_recorded", "past_due"]);
const LIVE_STATUSES = new Set([
  "scheduled",
  "booked",
  "qualified",
  "call_held",
  "follow_up",
  "follow_up_scheduled",
  "active",
  "allowed",
  "won",
  "payment_received",
  "in_progress",
]);

function toneForStatus(status: string): StatusTone {
  if (FAILED_STATUSES.has(status)) return "failed";
  if (OWED_STATUSES.has(status)) return "owed";
  if (LIVE_STATUSES.has(status)) return "live";
  return "done";
}

// Events that carry no status of their own: the word for what they leave.
const EVENT_STATUS: Record<string, { word: string; tone: StatusTone }> = {
  "customer.converted": { word: "Customer", tone: "live" },
  "customer.conversion_rolled_back": { word: "Rolled back", tone: "done" },
  "enrollment.created": { word: "Enrolled", tone: "live" },
  "enrollment.removed": { word: "Removed", tone: "done" },
  "followUp.booked": { word: "Booked", tone: "live" },
  "followUp.completed": { word: "Done", tone: "done" },
  "followUp.created": { word: "Open", tone: "owed" },
  "followUp.expired": { word: "Expired", tone: "failed" },
  "lead.captured": { word: "Captured", tone: "live" },
  "lead.capture_voided": { word: "Voided", tone: "done" },
  "lead.created": { word: "New", tone: "live" },
  "lead.merged": { word: "Merged", tone: "done" },
  "meeting.canceled": { word: "Canceled", tone: "done" },
  "meeting.created": { word: "Scheduled", tone: "live" },
  "meeting.no_show": { word: "No-show", tone: "failed" },
  "meeting.no_show_reverted": { word: "Reverted", tone: "done" },
  "opportunity.created": { word: "Open", tone: "live" },
  "opportunity.marked_lost": { word: "Lost", tone: "failed" },
  "payment.corrected": { word: "Corrected", tone: "done" },
  "payment.disputed": { word: "Disputed", tone: "failed" },
  "payment.recorded": { word: "To review", tone: "owed" },
  "payment.verified": { word: "Reviewed", tone: "done" },
  "payment.voided": { word: "Voided", tone: "failed" },
  "user.created": { word: "Added", tone: "live" },
  "user.deactivated": { word: "Deactivated", tone: "done" },
  "user.reactivated": { word: "Active", tone: "live" },
  "user.role_changed": { word: "Changed", tone: "done" },
};

/** A stored status as words: today's meeting labels, else the value in sentence case. */
function statusLabel(eventType: string, raw: string) {
  const label = meetingEventStatusLabel(eventType, raw) ?? raw;
  const meeting = eventType.startsWith("meeting.") && Object.hasOwn(meetingStatusConfig, label)
    ? meetingStatusConfig[label as keyof typeof meetingStatusConfig].label
    : null;
  const words = (meeting ?? label).replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The event's from and to states as labels, its status word, and the record line. */
function describeEvent(event: ActivityEvent) {
  const rawFrom =
    event.fromStatus ?? (typeof event.metadata?.fromStatus === "string" ? event.metadata.fromStatus : undefined);
  const rawTo = event.toStatus ?? (typeof event.metadata?.toStatus === "string" ? event.metadata.toStatus : undefined);
  // An old deal event holds statuses; a new one, stages with the outcomes in
  // its metadata (docs/plans/phase-5-deal-status.md §4.7).
  const dealOutcomes = event.entityType === "opportunity" ? dealEventOutcomes(event.metadata) : null;
  const fromLabel = dealOutcomes
    ? dealEventStateLabel(rawFrom, dealOutcomes.fromOutcome)
    : rawFrom
      ? statusLabel(event.eventType, rawFrom)
      : null;

  let status: { word: string; tone: StatusTone };
  if (rawTo && dealOutcomes && rawTo === "closed" && dealOutcomes.toOutcome && dealOutcomes.toOutcome !== "open") {
    status = { word: dealOutcomes.toOutcome === "won" ? "Won" : "Lost", tone: toneForStatus(dealOutcomes.toOutcome) };
  } else if (rawTo) {
    const label = dealOutcomes ? (dealEventStateLabel(rawTo, null) ?? rawTo) : statusLabel(event.eventType, rawTo);
    status = { word: label, tone: toneForStatus(rawTo === "completed" ? "held" : rawTo) };
  } else {
    status = EVENT_STATUS[event.eventType] ?? { word: "Logged", tone: "done" };
  }

  const payment = event.entityType === "payment" ? (event.paymentMetadata ?? null) : null;
  const parts = [ENTITY_LABELS[event.entityType] ?? event.entityType];
  if (payment) {
    if (payment.programName) parts.push(payment.programName);
    parts.push(PAYMENT_TYPE_LABELS[payment.paymentType] ?? payment.paymentType);
  }
  if (fromLabel && rawTo) parts.push(`from ${fromLabel}`);
  // An admin's reason for pausing or churning a program.
  if (event.entityType === "enrollment" && event.reason) parts.push(event.reason);

  return { status, record: parts.join(" · ") };
}

/** "Nov 5 · 11:15 AM", or the time alone when the band's range is one day. */
function whenWords(at: number, oneDay: boolean) {
  return oneDay ? format(at, "h:mm a") : format(at, "MMM d · h:mm a");
}

function sentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ActivityEventRow({ event, oneDay }: { event: ActivityEvent; oneDay: boolean }) {
  const { status, record } = describeEvent(event);
  const who = event.actor ? getMemberDisplayName(event.actor) : "System";
  const what = sentenceCase(getEventLabel(event.eventType).verb);
  const when = whenWords(event.occurredAt, oneDay);
  const iso = new Date(event.occurredAt).toISOString();

  return (
    <li className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/60">
      <div className={cn("flex flex-col gap-0.5 px-4 py-2 @3xl/feed:h-[43px] @3xl/feed:items-center @3xl/feed:py-0", FEED_COLUMNS)}>
        {/* WHEN, from @3xl */}
        <time dateTime={iso} className="hidden truncate font-condensed text-[15px] font-semibold tabular-nums @3xl/feed:block">
          {when}
        </time>

        {/* WHO; on narrow rows what and the status ride the same line */}
        <div className="flex min-w-0 items-center gap-3">
          <p className={cn("min-w-0 flex-1 truncate font-semibold", !event.actor && "text-muted-foreground")}>
            {who}
            <span className="font-normal text-foreground @3xl/feed:hidden"> · {what}</span>
          </p>
          <span className="@3xl/feed:hidden">
            <StatusWord tone={status.tone}>{status.word}</StatusWord>
          </span>
        </div>

        {/* Line 2 on narrow rows: when · record */}
        <p className="truncate text-[13px] text-muted-foreground @3xl/feed:hidden" title={record}>
          <time dateTime={iso} className="font-condensed text-[14px] tabular-nums">
            {when}
          </time>
          {" · "}
          {record}
        </p>

        {/* WHAT */}
        <p className="hidden truncate @3xl/feed:block" title={what}>
          {what}
        </p>

        {/* RECORD */}
        <p className="hidden truncate text-[13px] text-muted-foreground @3xl/feed:block" title={record}>
          {record}
        </p>

        {/* STATUS, from @3xl */}
        <span className="hidden truncate @3xl/feed:block">
          <StatusWord tone={status.tone}>{status.word}</StatusWord>
        </span>
      </div>
    </li>
  );
}
