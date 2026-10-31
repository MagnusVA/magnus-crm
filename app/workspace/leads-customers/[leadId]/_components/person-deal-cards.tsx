"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { AttributionTouch } from "@/convex/lib/attribution/detailPayload";
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
import { ROW_LINK, StageWord, StepWords } from "@/app/workspace/closer/pipeline/_components/deal-cells";
import {
  DealCreditLine,
  DealStageTrack,
  TOUCH_CHANNEL_LABELS,
} from "@/app/workspace/_components/deal-stage-track";
import { SetNextStepButton } from "@/app/workspace/_components/set-next-step-button";
import { useEntityDetail, type EntityDetailPayload } from "./entity-detail-context";
import { meetingDetailHref } from "./meeting-link-utils";
import { useOpportunitySheet } from "./opportunity-sheet-context";
import { DealCalls, useDealCalls } from "./person-deal-calls";
import { personDate } from "./person-format";
import { usePersonDeals, type PersonDealEntry } from "./person-deals";

/**
 * The person's deals: a full card per open deal (its track, credit, calls
 * and next step), the ones that need a step first; the won and lost deals
 * folded into one "Closed deals" list under them. A person with no open
 * deal keeps the newest closed one as a full card.
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

  const open = deals.filter((deal) => deal.outcome === "open");
  const closed = deals
    .filter((deal) => deal.outcome !== "open")
    .sort((a, b) => b.createdAt - a.createdAt);
  const full = open.length > 0 ? open : closed.slice(0, 1);
  const listed = open.length > 0 ? closed : closed.slice(1);

  return (
    <section aria-label="Deals" className="flex flex-col gap-3.5">
      {full.map((deal) => (
        <PersonDealCard key={deal.item.opportunity._id} deal={deal} />
      ))}
      {listed.length > 0 ? <ClosedDealsCard deals={listed} /> : null}
      {caps.opportunities ? (
        <p className="px-1 text-[0.8125rem] text-muted-foreground">Showing the newest 50 deals</p>
      ) : null}
    </section>
  );
}

function PersonDealCard({ deal }: { deal: PersonDealEntry }) {
  const { lead, viewer, payments, firstTouch: personFirstTouch } = useEntityDetail();
  const {
    actions: { openOpportunity },
  } = useOpportunitySheet();
  const { item } = deal;
  const { opportunity, closer, permissions, nextStep } = item;
  const program = dealProgramName(opportunity);
  const closerName = closer?.fullName ?? closer?.email ?? null;
  const ownView = permissions.canOpenOpportunity;
  const titleId = `deal-${opportunity._id}`;
  const { owed } = useDealCalls(opportunity._id);
  // A won deal's header carries what it paid, each currency on its own.
  const paid =
    deal.outcome === "won"
      ? paidByCurrency(payments.filter((payment) => payment.opportunityId === opportunity._id))
      : [];
  const taskHref =
    nextStep?.taskId && deal.canAct
      ? `${viewer.role === "closer" ? "/workspace/closer/reminders" : "/workspace/pipeline/reminders"}/${nextStep.taskId}`
      : null;
  // The call row's "Record outcome" is the deal's next action; the footer
  // doesn't repeat it, and no second lime button joins it.
  const callCarriesStep = owed !== null && deal.state?.kind === "not_recorded";
  const firstTouch = item.attribution?.firstTouch ?? personFirstTouch;

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
      <DealCalls opportunityId={opportunity._id} canOpenDeal={ownView} />
      <DetailCardFooter className="text-sm">
        {callCarriesStep ? (
          <FirstTouchFact touch={firstTouch} />
        ) : (
          <DealFact deal={deal} viewerRole={viewer.role} />
        )}
        {deal.canAct || ownView ? (
          <div className="ml-auto flex flex-wrap items-center gap-x-3.5 gap-y-1">
            <SetNextStepButton
              canSet={deal.canAct && !!nextStep?.canSet && deal.state?.kind !== "step" && owed === null}
              opportunityId={opportunity._id}
              leadName={lead.fullName ?? null}
            />
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

/** "First touch Calendly · Jun 18", when the call row carries the deal's next action. */
function FirstTouchFact({ touch }: { touch: AttributionTouch | null }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  if (!touch) return <span className="text-[0.8125rem] font-normal">First touch not recorded</span>;
  return (
    <span className="min-w-0 truncate text-[0.8125rem] font-normal" suppressHydrationWarning>
      First touch {TOUCH_CHANNEL_LABELS[touch.channel]} ·{" "}
      <span className="font-condensed text-sm font-semibold tabular-nums">{personDate(touch.occurredAt, setting, now)}</span>
    </span>
  );
}

/**
 * The won and lost deals, one ruled row each: program, stage word, closer,
 * what it paid or why it was lost, and the date. A row opens the deal
 * modal; another closer's deal is a plain row.
 */
function ClosedDealsCard({ deals }: { deals: PersonDealEntry[] }) {
  return (
    <DetailCard
      title="Closed deals"
      meta={<span className="font-condensed text-sm font-semibold tabular-nums">{deals.length}</span>}
      className="@container/closed"
    >
      <ul className="divide-y">
        {deals.map((deal) => (
          <ClosedDealRow key={deal.item.opportunity._id} deal={deal} />
        ))}
      </ul>
    </DetailCard>
  );
}

function ClosedDealRow({ deal }: { deal: PersonDealEntry }) {
  const { payments } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const {
    actions: { openOpportunity },
  } = useOpportunitySheet();
  const { opportunity, closer, permissions } = deal.item;
  const program = dealProgramName(opportunity) ?? "No program";
  const closerName = closer?.fullName ?? closer?.email ?? "No closer";
  const own = payments.filter((payment) => payment.opportunityId === opportunity._id);
  const latestPayment = own.reduce<number | null>(
    (max, payment) => (max === null || payment.recordedAt > max ? payment.recordedAt : max),
    null,
  );
  const when =
    deal.outcome === "won"
      ? (latestPayment ?? opportunity.paymentReceivedAt ?? null)
      : (opportunity.lostAt ?? null);
  // A loss the system wrote is already named by the stage word ("Lost: no-show").
  const reason = opportunity.systemLoss ? null : opportunity.lostReason?.trim() || null;
  const amounts = paidByCurrency(own);

  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-0.5 px-4 py-2 hover:bg-muted/60 @xl/closed:min-h-11 @xl/closed:grid-cols-[minmax(0,1.3fr)_8.5rem_minmax(0,1fr)_minmax(0,1.2fr)_4.5rem] @xl/closed:py-1.5">
      <p className="min-w-0 truncate font-medium" title={program}>
        {permissions.canOpenOpportunity ? (
          <button type="button" className={cn(ROW_LINK, "text-left")} onClick={() => openOpportunity(opportunity._id)}>
            {program}
          </button>
        ) : (
          program
        )}
      </p>
      <StageWord position={opportunity.position} systemLoss={opportunity.systemLoss} className="justify-self-end @xl/closed:justify-self-start" />
      <p className="col-span-2 min-w-0 truncate text-[0.8125rem] text-muted-foreground @xl/closed:col-span-1" translate="no">
        {closerName}
      </p>
      <p className="col-span-2 min-w-0 truncate text-[0.8125rem] empty:hidden @xl/closed:col-span-1" title={deal.outcome === "lost" ? (reason ?? undefined) : undefined}>
        {deal.outcome === "won" ? (
          amounts.length > 0 ? (
            <span className="font-condensed text-[15px] font-semibold tabular-nums">
              {amounts.map((entry) => formatCash(entry.amountMinor, entry.currency)).join(" · ")}
            </span>
          ) : (
            <span className="text-muted-foreground">No payments shown</span>
          )
        ) : (
          reason ? <span className="text-danger-ink">{reason}</span> : null
        )}
      </p>
      <p className="hidden text-right font-condensed text-sm font-semibold text-muted-foreground tabular-nums @xl/closed:block" suppressHydrationWarning>
        {when ? personDate(when, setting, now) : null}
      </p>
    </li>
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
