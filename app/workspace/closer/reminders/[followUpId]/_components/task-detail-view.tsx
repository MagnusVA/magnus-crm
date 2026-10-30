"use client";

import { useNow } from "@/hooks/use-now";
import { useBusinessDay } from "@/hooks/use-business-day";
import { formatCurrency } from "@/lib/format-currency";
import { formatShortDate } from "@/app/workspace/closer/_components/today-time";
import { DealCard } from "@/app/workspace/closer/meetings/_components/deal-card";
import { firstNameOf } from "@/app/workspace/closer/meetings/_components/meeting-detail-types";
import { DealCallsCard, PaymentLinksCard } from "./deal-calls-card";
import { ReachCard } from "./reach-card";
import { TaskNoteCard } from "./task-note-card";
import { TaskOutcomeSection } from "./task-outcome-section";
import { TaskStrip } from "./task-strip";
import { taskKindLabel, type TaskDetail, type TaskDetailMode } from "./task-detail-types";

type TaskDetailViewProps = {
  detail: TaskDetail;
  mode: TaskDetailMode;
  /** The task's closer, named on the admin twin ("Acting for …"). */
  closerName: string | null;
  /** After an outcome closes the task. */
  onCompleted: () => void;
};

/** "Paid $1,500 · 2 payments", or how many when they're in different currencies. */
export function paymentsFact(payments: TaskDetail["payments"]): string {
  if (payments.length === 0) return "No payments yet";
  const count = payments.length === 1 ? "1 payment" : `${payments.length} payments`;
  const currency = payments[0].currency;
  if (payments.some((payment) => payment.currency !== currency)) return count;
  const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
  return payments.length === 1
    ? `Paid ${formatCurrency(total, currency)}`
    : `Paid ${formatCurrency(total, currency)} · ${count}`;
}

/**
 * The task pane, shared by the closer's page and the admin twin: the task as
 * a board row; why it exists, how to reach the person and the outcome on
 * the left; the deal, its calls and its payment links on the right. `mode`
 * picks which outcomes the panel offers.
 */
export function TaskDetailView({ detail, mode, closerName, onCompleted }: TaskDetailViewProps) {
  const now = useNow();
  const { setting } = useBusinessDay();
  const { followUp, opportunity, lead, dealMeetings, payments, paymentLinks } = detail;

  const personName = lead.fullName ?? lead.email ?? "Unknown person";
  const firstName = firstNameOf(lead.fullName) ?? personName;
  const programName =
    (opportunity.position === "won" ? opportunity.soldProgramName : null) ??
    opportunity.firstBookingProgramName ??
    null;
  const dealLine =
    dealMeetings.length === 0
      ? "no calls yet"
      : dealMeetings.length === 1
        ? "1 call"
        : `${dealMeetings.length} calls`;
  const meetingBasePath =
    mode === "admin" ? "/workspace/pipeline/meetings" : "/workspace/closer/meetings";

  return (
    <div className="@container flex flex-col gap-3.5">
      <TaskStrip
        followUp={followUp}
        now={now}
        setting={setting}
        personName={personName}
        personLine={`${taskKindLabel(followUp)} · set ${formatShortDate(followUp.createdAt, setting.timeZone)}`}
        programName={programName}
        position={opportunity.position}
        systemLoss={opportunity.systemLoss}
        dealLine={dealLine}
        phone={lead.phone ?? null}
      />

      <div className="grid grid-cols-1 gap-3.5 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:gap-x-[1.125rem] @5xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <TaskNoteCard
            detail={detail}
            mode={mode}
            setting={setting}
            firstName={firstName}
            closerName={closerName}
          />
          <ReachCard
            personName={personName}
            phone={lead.phone ?? null}
            email={lead.email ?? null}
            personHref={`/workspace/leads-customers/${lead._id}`}
            method={followUp.contactMethod === "text" ? "text" : "call"}
            open={followUp.status === "pending"}
          />
          <TaskOutcomeSection
            detail={detail}
            mode={mode}
            setting={setting}
            firstName={firstName}
            leadName={lead.fullName ?? lead.email ?? null}
            closerName={closerName}
            onCompleted={onCompleted}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          <DealCard
            detail={{
              opportunity,
              meeting: null,
              lead,
              dealAttribution: detail.dealAttribution,
              attributionTeam: detail.attributionTeam,
              dmCloser: detail.dmCloser,
              assignedCloser: detail.dealCloser,
            }}
            fact={paymentsFact(payments)}
          />
          <DealCallsCard
            meetings={dealMeetings}
            now={now}
            setting={setting}
            meetingBasePath={meetingBasePath}
          />
          {paymentLinks.length > 0 ? <PaymentLinksCard paymentLinks={paymentLinks} /> : null}
        </div>
      </div>
    </div>
  );
}
