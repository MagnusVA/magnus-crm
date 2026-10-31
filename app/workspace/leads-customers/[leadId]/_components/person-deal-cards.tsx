"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { SYSTEM_LOSS_REASON_LABELS } from "@/convex/opportunities/stages";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { formatCash } from "@/lib/closer-pipeline";
import { dealProgramName, paidByCurrency } from "@/lib/person-page";
import { cn } from "@/lib/utils";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
  detailLinkClass,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { StageChip } from "@/app/workspace/closer/meetings/_components/stage-tone";
import { StepWords } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import { DealCreditLine, DealStageTrack } from "@/app/workspace/_components/deal-stage-track";
import { SetNextStepButton } from "@/app/workspace/_components/set-next-step-button";
import { useEntityDetail, type EntityDetailPayload } from "./entity-detail-context";
import { meetingDetailHref } from "./meeting-link-utils";
import { useOpportunitySheet } from "./opportunity-sheet-context";
import { personDate } from "./person-format";
import { usePersonDeals, type PersonDealEntry } from "./person-deals";

/**
 * One card per deal: its program, stage chip and closer, the stage track,
 * who gets credit, and a footer with the deal's next step (or what it
 * paid, or why it was lost) beside its actions. Open deals come first, the
 * ones that need a step at the top.
 */
export function PersonDealCards() {
  const { caps } = useEntityDetail();
  const deals = usePersonDeals();

  if (deals.length === 0) {
    return (
      <Card className="gap-0 py-0">
        <SectionEmpty title="No deals yet.">
          A deal starts when the person books a call through Calendly, or when a closer opens a
          side deal.
        </SectionEmpty>
      </Card>
    );
  }

  return (
    <section aria-label="Deals" className="flex flex-col gap-3.5">
      {deals.map((deal) => (
        <PersonDealCard key={deal.item.opportunity._id} deal={deal} />
      ))}
      {caps.opportunities ? (
        <p className="px-1 text-[0.8125rem] text-muted-foreground">Showing the newest 50 deals</p>
      ) : null}
    </section>
  );
}

function PersonDealCard({ deal }: { deal: PersonDealEntry }) {
  const { lead, viewer, payments } = useEntityDetail();
  const {
    actions: { openOpportunity },
  } = useOpportunitySheet();
  const { item } = deal;
  const { opportunity, closer, permissions, nextStep } = item;
  const program = dealProgramName(opportunity);
  const closerName = closer?.fullName ?? closer?.email ?? null;
  const ownView = permissions.canOpenOpportunity;
  const titleId = `deal-${opportunity._id}`;
  // A won deal's header carries what it paid, each currency on its own.
  const paid =
    deal.outcome === "won"
      ? paidByCurrency(payments.filter((payment) => payment.opportunityId === opportunity._id))
      : [];
  const taskHref =
    nextStep?.taskId && deal.canAct
      ? `${viewer.role === "closer" ? "/workspace/closer/reminders" : "/workspace/pipeline/reminders"}/${nextStep.taskId}`
      : null;

  return (
    <DetailCard
      title={program ?? "No program"}
      titleId={titleId}
      badge={<StageChip position={opportunity.position} systemLoss={opportunity.systemLoss} />}
      meta={
        <span className="truncate" translate="no">
          {ownView ? (closerName ?? "No closer") : closerName ? `Deal of ${closerName}` : "No closer"}
          {paid.map((entry) => (
            <span key={entry.currency}>
              {" · "}
              <b className="font-condensed text-sm font-semibold text-foreground tabular-nums">
                {formatCash(entry.amountMinor, entry.currency)}
              </b>
            </span>
          ))}
        </span>
      }
    >
      <DealStageTrack position={opportunity.position} systemLoss={opportunity.systemLoss} />
      <DealCreditLine source={{ dealAttribution: item.attribution, assignedCloser: closer }} />
      <DetailCardFooter className="text-sm">
        <DealFact deal={deal} viewerRole={viewer.role} />
        {deal.canAct || ownView ? (
          <div className="ml-auto flex flex-wrap items-center gap-x-3.5 gap-y-1">
            {deal.canAct && nextStep?.canSet && deal.state?.kind !== "step" ? (
              <SetNextStepButton opportunityId={opportunity._id} leadName={lead.fullName ?? null} />
            ) : null}
            {taskHref ? (
              <Link href={taskHref} className={detailLinkClass}>
                Open task
              </Link>
            ) : null}
            {ownView ? (
              <button
                type="button"
                className={detailLinkClass}
                onClick={() => openOpportunity(opportunity._id)}
                aria-describedby={titleId}
              >
                Open deal
              </button>
            ) : null}
          </div>
        ) : null}
      </DetailCardFooter>
    </DetailCard>
  );
}

/** The footer's fact in condensed figures, as the board sets times and amounts. */
const FACT = "font-condensed text-[15px] font-semibold tracking-[0.02em] text-foreground tabular-nums";
/** The fact's lead word ("Call", "Paid", "Call back") and its date, quieter than the figure. */
const LEAD_WORD = "font-medium text-muted-foreground";

const FLAG =
  "inline-flex h-5 shrink-0 items-center rounded-[4px] bg-warning-surface px-1.5 text-xs font-semibold whitespace-nowrap text-warning-ink";

/** The footer's fact: the next step on an open deal, what a won deal paid, why a deal was lost. */
function DealFact({
  deal,
  viewerRole,
}: {
  deal: PersonDealEntry;
  viewerRole: EntityDetailPayload["viewer"]["role"];
}) {
  const { payments } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const { opportunity } = deal.item;

  if (deal.outcome === "won") {
    const own = payments.filter((payment) => payment.opportunityId === opportunity._id);
    const amounts = paidByCurrency(own);
    const latest = own.reduce<number | null>(
      (max, payment) => (max === null || payment.recordedAt > max ? payment.recordedAt : max),
      null,
    );
    const when = latest ?? opportunity.paymentReceivedAt ?? null;
    return (
      <span className={cn(FACT, "min-w-0 truncate")} suppressHydrationWarning>
        {amounts.length === 0 ? (
          <span className={LEAD_WORD}>Won</span>
        ) : (
          <>
            <span className={LEAD_WORD}>Paid</span>{" "}
            {amounts.map((entry) => formatCash(entry.amountMinor, entry.currency)).join(" · ")}
          </>
        )}
        {when ? <span className={LEAD_WORD}> · {personDate(when, setting, now)}</span> : null}
      </span>
    );
  }

  if (deal.outcome === "lost") {
    const reason = opportunity.systemLoss
      ? SYSTEM_LOSS_REASON_LABELS[opportunity.systemLoss]
      : (opportunity.lostReason?.trim() || "Lost");
    return (
      <span className={cn(FACT, "min-w-0 truncate")} title={reason} suppressHydrationWarning>
        <span className="text-danger-ink">{reason}</span>
        {opportunity.lostAt ? (
          <span className={LEAD_WORD}> · {personDate(opportunity.lostAt, setting, now)}</span>
        ) : null}
      </span>
    );
  }

  const state = deal.state;
  if (state?.kind === "step") {
    return (
      <span className={cn(FACT, "min-w-0 truncate")} suppressHydrationWarning>
        <StepWords step={state.step} now={now} setting={setting} verbClassName={LEAD_WORD} />
      </span>
    );
  }
  if (state?.kind === "not_recorded") {
    const meeting = deal.callMeeting;
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1" suppressHydrationWarning>
        <span className={FLAG}>Not recorded</span>
        <span className={FACT}>
          <span className={LEAD_WORD}>Call</span> {personDate(state.callAt, setting, now)}
        </span>
        {meeting && meeting.permissions.canOpenMeeting ? (
          <Link href={meetingDetailHref({ meetingId: meeting._id, viewerRole })} className={detailLinkClass}>
            Record outcome
          </Link>
        ) : null}
      </span>
    );
  }
  return <span className={FLAG}>No next step</span>;
}
