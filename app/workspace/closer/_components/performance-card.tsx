"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { CloserPipelineTab } from "@/convex/closer/pipelineTabs";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  businessDateToCalendarDate,
  calendarDateToBusinessDate,
  validateCustomDashboardRange,
} from "@/app/workspace/_components/dashboard-date-utils";
import { formatRangeLabel, performanceRange, type PerformancePeriod } from "./today-time";

type Summary = FunctionReturnType<typeof api.closer.dashboard.getPipelineSummary>;

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const SIGNED_MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
  signDisplay: "exceptZero",
});
const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

// The deal-stage bar's segments, in the pipeline tabs' order. Closers own no
// Qualified deals, so it has none. `fill` is the bar and dot; the legend's
// count stays in the foreground colour.
const STAGES: Array<{ position: CloserPipelineTab; fill: string }> = [
  { position: "booked", fill: "bg-stage-booked" },
  { position: "call_held", fill: "bg-stage-held" },
  { position: "follow_up", fill: "bg-stage-follow-up" },
  { position: "won", fill: "bg-stage-won" },
  { position: "lost", fill: "bg-stage-lost" },
];

const PRESETS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

/**
 * How the closer's period went: cash, wins, close rate and show-up rate,
 * each with the counts behind it, then the period's deals by stage.
 *
 * Everything comes from `getPipelineSummary` over the closer's calls
 * scheduled in the period (business days): the deals behind those calls,
 * the payments recorded in it, and the calls' attendance. The cash change is
 * a second call of the same query over the previous period, cut to the same
 * elapsed length.
 */
export function PerformanceCard({
  setting,
  now,
}: {
  setting: BusinessDaySetting;
  now: number;
}) {
  const [period, setPeriod] = useState<PerformancePeriod>({ kind: "preset", preset: "week" });
  // Presets move with the business day, and the previous period's cut with
  // the hour, not with every clock tick.
  const businessDate = businessDateForInstant(now, setting);
  const hour = Math.floor(now / 3_600_000);
  const range = useMemo(
    () => performanceRange(period, businessDate, (hour + 1) * 3_600_000, setting),
    [period, hour, businessDate, setting],
  );

  const current = useQuery(api.closer.dashboard.getPipelineSummary, {
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const previous = useQuery(api.closer.dashboard.getPipelineSummary, range.previous);

  return (
    <section
      aria-labelledby="performance-title"
      className="rounded-xl border bg-card text-sm text-card-foreground"
    >
      <header className="flex min-h-[46px] flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2">
        <h2 id="performance-title" className="text-[15px] font-semibold">
          Performance
        </h2>
        <span className="text-[13px] text-muted-foreground">
          {formatRangeLabel(range.startDate, range.endDate, setting)}
        </span>
        <PeriodControl period={period} onChange={setPeriod} />
      </header>

      {current === undefined ? (
        <PerformanceSkeleton />
      ) : (
        <PerformanceBody
          current={current}
          previous={previous}
          periodNoun={range.periodNoun}
          comparisonLabel={range.comparisonLabel}
        />
      )}
    </section>
  );
}

function PerformanceBody({
  current,
  previous,
  periodNoun,
  comparisonLabel,
}: {
  current: Summary;
  previous: Summary | undefined;
  periodNoun: string;
  comparisonLabel: string;
}) {
  const cash = current.cashCollectedMinor ?? 0;
  const payments = current.cashPaymentCount ?? 0;
  const previousCash = previous?.cashCollectedMinor;
  // Nothing in either period says nothing; leave the change out.
  const change =
    previousCash == null || (cash === 0 && previousCash === 0) ? null : cash - previousCash;

  const won = current.counts.won;
  const decided = current.decided ? current.decided.won + current.decided.lost : 0;
  // A ranged summary always carries the attendance and the meeting cap.
  const held = "heldCount" in current ? current.heldCount : 0;
  const recorded = held + ("noShowCount" in current ? current.noShowCount : 0);
  const partialMeetings = "isMeetingDataTruncated" in current && current.isMeetingDataTruncated;

  const stageTotal = STAGES.reduce((sum, stage) => sum + current.counts[stage.position], 0);

  return (
    <>
      <dl className="grid grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <Figure
          label="Cash collected"
          value={MONEY.format(cash / 100)}
          className="border-r border-b lg:border-b-0"
        >
          {change !== null ? (
            <>
              <span
                className={cn(
                  "font-semibold",
                  change > 0 ? "text-primary-ink" : change < 0 ? "text-danger-ink" : "",
                )}
              >
                {change === 0 ? "No change" : SIGNED_MONEY.format(change / 100)}
              </span>{" "}
              {comparisonLabel} ·{" "}
            </>
          ) : null}
          {payments} {payments === 1 ? "payment" : "payments"}
          {current.isPaymentDataTruncated ? " (partial)" : ""}
        </Figure>
        <Figure label="Won" value={String(won)} className="border-b lg:border-r lg:border-b-0">
          of {current.total} {current.total === 1 ? "deal" : "deals"} {periodNoun}
        </Figure>
        <Figure
          label="Close rate"
          value={decided === 0 ? "—" : PERCENT.format(won / decided)}
          className="border-r"
          help="Won ÷ decided: the deals won, plus the deals you or an admin marked lost. Deals a no-show or a cancellation closed are left out."
        >
          {decided === 0 ? "No deals decided yet" : `${won} of ${decided} decided`}
        </Figure>
        <Figure
          label="Show-up rate"
          value={recorded === 0 ? "—" : PERCENT.format(held / recorded)}
          help="Held ÷ (held + no-show) for your calls in the period. Calls with no result yet, and canceled calls, are left out."
        >
          {recorded === 0
            ? "No calls with a result yet"
            : `${held} of ${recorded} ${recorded === 1 ? "call" : "calls"} with a result`}
          {partialMeetings ? " (partial)" : ""}
        </Figure>
      </dl>

      <div className="border-t px-4 pt-3 pb-3.5">
        <div className="mb-2 flex items-baseline justify-between gap-3 font-medium text-muted-foreground">
          <h3 className="text-sm">Deal stages {periodNoun}</h3>
          <span className="text-[13px]">
            {stageTotal} {stageTotal === 1 ? "deal" : "deals"}
            {partialMeetings ? " (partial)" : ""}
          </span>
        </div>
        {stageTotal === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No calls {periodNoun === "in this range" ? "in this range" : periodNoun} yet, so no deals to show.
          </p>
        ) : (
          <>
            <div
              role="img"
              aria-label={STAGES.map(
                (stage) => `${dealPositionLabel(stage.position)} ${current.counts[stage.position]}`,
              ).join(", ")}
              className="flex h-2.5 gap-0.5 overflow-hidden rounded-full"
            >
              {STAGES.filter((stage) => current.counts[stage.position] > 0).map((stage) => (
                <span
                  key={stage.position}
                  className={stage.fill}
                  style={{ flexGrow: current.counts[stage.position], flexBasis: 0 }}
                />
              ))}
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
              {STAGES.map((stage) => (
                <li key={stage.position}>
                  <Link
                    href={`/workspace/closer/pipeline?stage=${stage.position}`}
                    className="inline-flex min-h-6 items-center rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className={cn("mr-1.5 size-2 rounded-[2px]", stage.fill)} aria-hidden="true" />
                    {dealPositionLabel(stage.position)}
                    <span className="ml-1 font-semibold text-foreground tabular-nums">
                      {current.counts[stage.position]}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function Figure({
  label,
  value,
  help,
  className,
  children,
}: {
  label: string;
  value: string;
  help?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col px-4 pt-3.5 pb-3", className)} title={help}>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="contents">
        <span className="mt-1 mb-0.5 font-condensed text-[32px] leading-[1.05] font-semibold tabular-nums">
          {value}
        </span>
        <span className="text-[13px] text-muted-foreground">{children}</span>
      </dd>
    </div>
  );
}

function PeriodControl({
  period,
  onChange,
}: {
  period: PerformancePeriod;
  onChange: (period: PerformancePeriod) => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(() =>
    period.kind === "custom"
      ? {
          from: businessDateToCalendarDate(period.startDate),
          to: businessDateToCalendarDate(period.endDateInclusive),
        }
      : undefined,
  );
  const draftRange = {
    startBusinessDate: draft?.from ? calendarDateToBusinessDate(draft.from) : undefined,
    endBusinessDateInclusive: draft?.to ? calendarDateToBusinessDate(draft.to) : undefined,
  };
  const draftError = validateCustomDashboardRange(draftRange);

  return (
    <div className="ml-auto flex items-center gap-1.5">
      <ToggleGroup
        type="single"
        size="sm"
        value={period.kind === "preset" ? period.preset : ""}
        onValueChange={(next) => {
          if (next === "day" || next === "week" || next === "month") {
            onChange({ kind: "preset", preset: next });
          }
        }}
        aria-label="Performance period"
        className="rounded-[7px] border bg-background p-0.5"
      >
        {PRESETS.map((preset) => (
          <ToggleGroupItem
            key={preset.value}
            value={preset.value}
            className="h-6 rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
          >
            {preset.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={period.kind === "custom" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-[13px] text-muted-foreground aria-expanded:text-foreground data-[custom=true]:text-foreground"
            data-custom={period.kind === "custom"}
          >
            <CalendarIcon data-icon="inline-start" aria-hidden="true" />
            Custom
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[calc(100vw-2rem)] max-w-fit p-2">
          <Calendar
            mode="range"
            selected={draft}
            onSelect={setDraft}
            numberOfMonths={isMobile ? 1 : 2}
          />
          <div className="flex items-center justify-between gap-3 border-t px-2 pt-2">
            <p className="min-w-0 text-xs text-muted-foreground">{draftError ?? "Business days, start to end."}</p>
            <Button
              size="sm"
              disabled={draftError !== null}
              onClick={() => {
                if (!draftRange.startBusinessDate || !draftRange.endBusinessDateInclusive) return;
                onChange({
                  kind: "custom",
                  startDate: draftRange.startBusinessDate,
                  endDateInclusive: draftRange.endBusinessDateInclusive,
                });
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function PerformanceSkeleton() {
  return (
    <div role="status" aria-label="Loading performance">
      <div className="grid grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex flex-col gap-2 px-4 pt-3.5 pb-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2.5 border-t px-4 pt-3 pb-3.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
    </div>
  );
}
