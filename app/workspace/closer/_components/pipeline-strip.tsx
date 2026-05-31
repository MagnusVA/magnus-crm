import Link from "next/link";
import {
  BanknoteIcon,
  InfoIcon,
  type LucideIcon,
  TargetIcon,
  TrophyIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";

type PipelineStripProps = {
  counts: Record<string, number>;
  total: number;
  rangeLabel?: string;
  periodNoun?: string;
  cashCollectedMinor?: number | null;
  cashPaymentCount?: number | null;
  isPaymentDataTruncated?: boolean;
};

const CURRENCY_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const PERCENT_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
});

/**
 * Statuses surfaced to a phone closer, in a glance-friendly narrative order:
 * still-active work first, then the won outcome, then the negative outcomes.
 * `qualified_pending` is intentionally omitted — it's an SDR/lead-gen concern,
 * not something the closer acts on here.
 */
const CLOSER_PIPELINE_ORDER: OpportunityStatus[] = [
  "scheduled",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "no_show",
  "canceled",
  "lost",
];

const STATUS_HELP: Record<OpportunityStatus, string> = {
  qualified_pending: "Qualified leads waiting for a meeting to be booked.",
  scheduled: "Booked meetings that have not reached a final outcome yet.",
  follow_up_scheduled: "Leads with a committed follow-up after a meeting.",
  payment_received: "Won opportunities with a logged commissionable payment.",
  reschedule_link_sent: "Leads that received a reschedule link.",
  lost: "Opportunities marked as lost in this period.",
  canceled: "Meetings canceled through Calendly or the pipeline.",
  no_show: "Meetings where the invitee did not show.",
};

/**
 * Performance panel for the closer dashboard.
 *
 * Headline KPIs (cash, won, close rate) sit on top for an at-a-glance read of
 * how the selected period is going, followed by a condensed pipeline breakdown
 * so the closer can see exactly what happened without scanning a row of cards.
 */
export function PipelineStrip({
  counts,
  total,
  rangeLabel,
  periodNoun,
  cashCollectedMinor,
  cashPaymentCount,
  isPaymentDataTruncated,
}: PipelineStripProps) {
  const wonCount = counts.payment_received ?? 0;
  const lostCount = counts.lost ?? 0;
  // Close rate = won ÷ decided (won + lost). Open and in-progress stages
  // (scheduled, follow-up, reschedule, no-show, canceled) are excluded so the
  // rate reflects actual decisions rather than a diluted share of everything.
  const decidedCount = wonCount + lostCount;
  const closeRate = decidedCount > 0 ? wonCount / decidedCount : null;

  const cashValue =
    cashCollectedMinor === null || cashCollectedMinor === undefined
      ? "—"
      : CURRENCY_FORMATTER.format(cashCollectedMinor / 100);
  const cashDetail =
    cashPaymentCount === null || cashPaymentCount === undefined
      ? "Your collected cash"
      : `${cashPaymentCount} ${cashPaymentCount === 1 ? "payment" : "payments"}`;

  const scopedText = periodNoun ?? "this period";

  return (
    <TooltipProvider>
      <section
        aria-label="Performance summary"
        className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="text-sm font-semibold">Performance</h2>
            <HelpDot label="how performance is scoped">
              Cash, wins and pipeline are all scoped to your meetings inside the
              selected period.
            </HelpDot>
            {rangeLabel ? (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="truncate text-xs text-muted-foreground">
                  {rangeLabel}
                </span>
              </>
            ) : null}
          </div>
          {isPaymentDataTruncated ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="shrink-0">
                  Cash capped
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                There are more payments in this range than we scan live. Open a
                report for the exact total.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        {/* Headline KPIs */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <KpiTile
            icon={BanknoteIcon}
            label="Cash collected"
            value={cashValue}
            detail={cashDetail}
            help="Commissionable, non-disputed, non-deposit payments attributed to you in the selected period."
            tone="emerald"
            className="col-span-2 sm:col-span-1"
          />
          <KpiTile
            icon={TrophyIcon}
            label="Won"
            value={String(wonCount)}
            detail={`${total} ${total === 1 ? "opp" : "opps"} ${scopedText}`}
            help="Opportunities you won (payment received) in the selected period."
          />
          <KpiTile
            icon={TargetIcon}
            label="Close rate"
            value={closeRate === null ? "—" : PERCENT_FORMATTER.format(closeRate)}
            detail={
              decidedCount === 0
                ? "No decided opps"
                : `${wonCount} of ${decidedCount} decided`
            }
            help="Won ÷ decided opportunities (won + lost). Still-open stages like scheduled, follow-up and no-show are excluded."
          />
        </div>

        {/* Condensed pipeline breakdown */}
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {CLOSER_PIPELINE_ORDER.map((status) => {
            const config = opportunityStatusConfig[status];
            return (
              <PipelineChip
                key={status}
                status={status}
                label={config.label}
                count={counts[status] ?? 0}
                dotClass={config.dotClass}
                help={STATUS_HELP[status]}
              />
            );
          })}
        </div>
      </section>
    </TooltipProvider>
  );
}

type KpiTileProps = {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  help: string;
  tone?: "default" | "emerald";
  className?: string;
};

function KpiTile({
  icon: Icon,
  label,
  value,
  detail,
  help,
  tone = "default",
  className,
}: KpiTileProps) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border bg-background/60 p-2.5",
        tone === "emerald" &&
          "border-emerald-500/30 bg-emerald-500/6 dark:border-emerald-900/60",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
            )}
            aria-hidden="true"
          />
          <span className="truncate">{label}</span>
        </span>
        <HelpDot label={`what ${label} means`}>{help}</HelpDot>
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-2xl font-semibold tabular-nums leading-none",
          tone === "emerald" && "text-emerald-700 dark:text-emerald-300",
        )}
      >
        {value}
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

type PipelineChipProps = {
  status: OpportunityStatus;
  label: string;
  count: number;
  dotClass: string;
  help: string;
};

function PipelineChip({
  status,
  label,
  count,
  dotClass,
  help,
}: PipelineChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={`/workspace/closer/pipeline?status=${status}`}
          className={cn(
            "group flex min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 transition-colors hover:border-primary/30 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            count === 0 && "opacity-60 hover:opacity-100",
          )}
          aria-label={`${label}: ${count} ${
            count === 1 ? "opportunity" : "opportunities"
          }`}
        >
          <span
            className={cn("size-2 shrink-0 rounded-full", dotClass)}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium leading-tight">
            {label}
          </span>
          <span className="font-mono text-sm font-semibold tabular-nums">
            {count}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Small inline "?" affordance that reveals an explanation on hover/focus.
 * Kept tiny so it never competes with the metric it annotates.
 */
function HelpDot({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Explain ${label}`}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <InfoIcon className="size-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
