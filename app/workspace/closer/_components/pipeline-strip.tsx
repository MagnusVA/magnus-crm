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
  CLOSER_PIPELINE_TABS,
  type CloserPipelineTab,
} from "@/convex/closer/pipelineTabs";
import {
  DEAL_POSITION_LABELS,
  type DealPosition,
} from "@/convex/opportunities/stages";
import { DEAL_POSITION_STYLES } from "@/app/workspace/_components/pipeline/deal-position-badge";

type PipelineStripProps = {
  /** The deals behind the period's meetings, by position. */
  counts: Record<DealPosition, number>;
  total: number;
  /**
   * The close rate's inputs: the won deals, and the deals a person lost.
   * The losses a no-show or a cancellation wrote are left out. Null when the
   * summary has no period, which the dashboard always gives it.
   */
  decided: { won: number; lost: number } | null;
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
 * What each segment holds. The segments follow the pipeline page's tabs: the
 * open stages, then Won, then Lost. Qualified has none: closers own no
 * Qualified deals.
 */
const STAGE_HELP: Record<CloserPipelineTab, string> = {
  booked: "Deals with a booked call that hasn't happened or has no result yet.",
  call_held: "Side deals you opened after a call, waiting on a result.",
  follow_up: "Deals waiting on a next step: a reschedule link or a reminder.",
  won: "Deals won with a payment.",
  lost: "Deals closed as lost, including the ones a no-show or a cancellation ended.",
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
  decided,
  rangeLabel,
  periodNoun,
  cashCollectedMinor,
  cashPaymentCount,
  isPaymentDataTruncated,
}: PipelineStripProps) {
  const wonCount = counts.won;
  // Close rate = won ÷ decided (won + the deals a person lost). Open deals
  // and the deals a no-show or a cancellation closed are left out, so the
  // rate stays the closer's decisions rather than the missed meetings.
  const decidedCount = decided ? decided.won + decided.lost : 0;
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
            help="Deals you won with a payment, among the deals with a meeting in the selected period."
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
            help="Won ÷ decided (won + lost by you or an admin). Open deals, and the deals a no-show or a cancellation ended, are left out."
          />
        </div>

        {/* Condensed pipeline breakdown — a single stacked bar (100% = all
            scoped opportunities) plus a compact, clickable legend. */}
        <PipelineBar counts={counts} total={total} periodNoun={scopedText} />
      </section>
    </TooltipProvider>
  );
}

const PERCENT_OF_TOTAL = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
});

type PipelineBarProps = {
  counts: Record<DealPosition, number>;
  total: number;
  periodNoun: string;
};

function PipelineBar({ counts, total, periodNoun }: PipelineBarProps) {
  const segments = CLOSER_PIPELINE_TABS.map((stage) => {
    const count = counts[stage];
    return {
      stage,
      label: DEAL_POSITION_LABELS[stage],
      dotClass: DEAL_POSITION_STYLES[stage].dotClass,
      help: STAGE_HELP[stage],
      count,
      share: total > 0 ? count / total : 0,
    };
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          Pipeline activity
          <HelpDot label="pipeline activity">
            Every deal with a meeting in the selected period, split by its
            current stage, with Won and Lost apart. The bar is the full 100%.
          </HelpDot>
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {total} total
        </span>
      </div>

      {total === 0 ? (
        <div className="flex h-3 w-full items-center overflow-hidden rounded-full bg-muted">
          <span className="w-full px-2 text-center text-[10px] text-muted-foreground">
            No activity {periodNoun}
          </span>
        </div>
      ) : (
        <div
          className="flex h-3 w-full overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/5"
          role="img"
          aria-label={`Pipeline breakdown: ${segments
            .filter((s) => s.count > 0)
            .map((s) => `${s.label} ${s.count}`)
            .join(", ")}`}
        >
          {segments
            .filter((s) => s.count > 0)
            .map((s) => (
              <Tooltip key={s.stage}>
                <TooltipTrigger asChild>
                  <Link
                    href={`/workspace/closer/pipeline?stage=${s.stage}`}
                    className={cn(
                      "h-full min-w-[3px] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      s.dotClass,
                    )}
                    style={{ width: `${s.share * 100}%` }}
                    aria-label={`${s.label}: ${s.count} (${PERCENT_OF_TOTAL.format(
                      s.share,
                    )})`}
                  />
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  {s.label}: {s.count} · {PERCENT_OF_TOTAL.format(s.share)}
                  <span className="block opacity-80">{s.help}</span>
                </TooltipContent>
              </Tooltip>
            ))}
        </div>
      )}

      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s) => (
          <li key={s.stage} className="min-w-0">
            <Link
              href={`/workspace/closer/pipeline?stage=${s.stage}`}
              title={s.help}
              className={cn(
                "group flex items-center gap-1.5 rounded px-0.5 py-0.5 text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                s.count === 0 && "opacity-50 hover:opacity-100",
              )}
              aria-label={`${s.label}: ${s.count} ${
                s.count === 1 ? "opportunity" : "opportunities"
              }`}
            >
              <span
                className={cn("size-2 shrink-0 rounded-full", s.dotClass)}
                aria-hidden="true"
              />
              <span className="truncate text-muted-foreground group-hover:text-foreground">
                {s.label}
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {s.count}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
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
