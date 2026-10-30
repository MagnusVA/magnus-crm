"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { BusinessDaySetting } from "@/lib/businessDay";
import {
  buildProgramSections,
  countWithoutNextStep,
  mainCurrency,
  NO_PROGRAM,
  type PipelineMonth,
} from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { MoneyStrip } from "./money-strip";
import { DeskSkeleton } from "./pipeline-skeleton";
import { programLabel, ProgramCard } from "./program-card";
import { useKeptQuery } from "./use-kept-query";

type MonthCash = FunctionReturnType<typeof api.closer.pipelineDesk.getMonthCash>;
type MonthWins = FunctionReturnType<typeof api.closer.pipelineDesk.getMonthWins>;
type OpenDeals = FunctionReturnType<typeof api.closer.pipelineDesk.getOpenDeals>;

/**
 * The desk: the month's money strip, then one card per program. The month's
 * queries keep their last result while a new month loads, dimmed, so a
 * switch never flashes the skeleton; only the first load does.
 */
export function PipelineDesk({
  month,
  now,
  setting,
  onShowProgram,
}: {
  month: PipelineMonth;
  now: number;
  setting: BusinessDaySetting;
  onShowProgram: (programKey: string) => void;
}) {
  const range = { startDate: month.startDate, endDate: month.endDate };
  const cash = useKeptQuery(api.closer.pipelineDesk.getMonthCash, range);
  const previous = useKeptQuery(api.closer.pipelineDesk.getMonthCash, month.previous);
  const wins = useKeptQuery(api.closer.pipelineDesk.getMonthWins, range);
  const open = useQuery(api.closer.pipelineDesk.getOpenDeals, {});

  if (cash.data === undefined || wins.data === undefined || open === undefined) {
    return <DeskSkeleton />;
  }

  return (
    <PipelineDeskView
      month={month}
      now={now}
      setting={setting}
      cash={cash.data}
      previous={previous.data}
      wins={wins.data}
      open={open}
      isStale={cash.isStale || wins.isStale || previous.isStale}
      onShowProgram={onShowProgram}
    />
  );
}

/** The desk from its data: what PipelineDesk renders once its queries answer. */
export function PipelineDeskView({
  month,
  now,
  setting,
  cash,
  previous,
  wins,
  open,
  isStale,
  onShowProgram,
}: {
  month: PipelineMonth;
  now: number;
  setting: BusinessDaySetting;
  cash: MonthCash;
  previous: MonthCash | undefined;
  wins: MonthWins;
  open: OpenDeals;
  isStale: boolean;
  onShowProgram: (programKey: string) => void;
}) {
  // Last month's main currency breaks a tie in this month's payment counts.
  const currency = mainCurrency(cash.currencies, previous ? mainCurrency(previous.currencies) : null);
  const sections = buildProgramSections({ cash, wins, open }, currency, now);
  const paired = sections.length > 1;
  const programNames = sections
    .filter((section) => section.key !== NO_PROGRAM)
    .map((section) => programLabel(section.name));
  const hasDeals = open.programs.length > 0;

  return (
    <div
      aria-busy={isStale}
      className={cn("flex flex-col gap-3.5 transition-opacity duration-200", isStale && "opacity-60")}
    >
      <MoneyStrip
        month={month}
        currency={currency}
        cash={cash}
        previous={previous}
        wins={wins}
        open={{
          count: open.deals.length,
          withoutNextStep: countWithoutNextStep(open.deals, now),
          isPartial: open.isPartial,
        }}
        programs={programNames}
      />

      {sections.length === 0 ? (
        <section className="rounded-xl border bg-card text-card-foreground">
          {hasDeals ? (
            <SectionEmpty title={`No open deals, and no cash ${month.isCurrent ? "this month" : `in ${month.name}`}.`}>
              Every deal you worked is in All deals below.
            </SectionEmpty>
          ) : (
            <SectionEmpty title="No deals yet.">
              A deal lands here when someone books a call with you. Each program you sell gets its own
              section, with its cash this month and its open deals, and each deal its next step.
            </SectionEmpty>
          )}
        </section>
      ) : (
        <div className={cn("grid gap-3.5", paired && "xl:grid-cols-2")}>
          {sections.map((section) => (
            <ProgramCard
              key={section.key}
              section={section}
              month={month}
              now={now}
              setting={setting}
              paired={paired}
              onShowAll={onShowProgram}
            />
          ))}
        </div>
      )}

      {open.isPartial ? (
        <p className="text-[13px] text-muted-foreground">
          Showing your newest {open.deals.length.toLocaleString()} open deals. The rest are in All deals.
        </p>
      ) : null}
    </div>
  );
}

/** Whether the closer has any deal at all: the lookup has nothing to find otherwise. */
export function useHasAnyDeal(): boolean | undefined {
  const open = useQuery(api.closer.pipelineDesk.getOpenDeals, {});
  return open === undefined ? undefined : open.programs.length > 0;
}
