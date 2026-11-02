"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { BusinessDaySetting } from "@/lib/businessDay";
import {
  buildBookPrograms,
  mainCurrency,
  summarizeBook,
  type BookFilter,
  type PipelineMonth,
} from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BookPanel } from "./book-panel";
import { OpenDeals } from "./open-deals";
import { DeskSkeleton } from "./pipeline-skeleton";
import { useKeptQuery } from "./use-kept-query";

type MonthCash = FunctionReturnType<typeof api.closer.pipelineDesk.getMonthCash>;
type MonthWins = FunctionReturnType<typeof api.closer.pipelineDesk.getMonthWins>;
type OpenDealsData = FunctionReturnType<typeof api.closer.pipelineDesk.getOpenDeals>;

/**
 * The desk: the book panel (the month's money, where every open deal stands,
 * the programs), then the open deals as one list the panel filters. The
 * month's queries keep their last result while a new month loads, dimmed, so
 * a switch never flashes the skeleton; only the first load does.
 */
export function PipelineDesk({
  month,
  now,
  setting,
  filter,
  onFilter,
}: {
  month: PipelineMonth;
  now: number;
  setting: BusinessDaySetting;
  filter: BookFilter;
  onFilter: (filter: BookFilter) => void;
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
      filter={filter}
      onFilter={onFilter}
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
  filter,
  onFilter,
}: {
  month: PipelineMonth;
  now: number;
  setting: BusinessDaySetting;
  cash: MonthCash;
  previous: MonthCash | undefined;
  wins: MonthWins;
  open: OpenDealsData;
  isStale: boolean;
  filter: BookFilter;
  onFilter: (filter: BookFilter) => void;
}) {
  // Last month's main currency breaks a tie in this month's payment counts.
  const currency = mainCurrency(cash.currencies, previous ? mainCurrency(previous.currencies) : null);
  const summary = summarizeBook(open.deals, now);
  const programs = buildBookPrograms({ cash, wins, open }, currency, now);
  const hasDeals = open.programs.length > 0;

  return (
    <div className="flex flex-col gap-3.5">
      <div aria-busy={isStale} className={cn("transition-opacity duration-200", isStale && "opacity-60")}>
        <BookPanel
          month={month}
          currency={currency}
          cash={cash}
          previous={previous}
          wins={wins}
          summary={summary}
          isPartial={open.isPartial}
          programs={programs}
          filter={filter}
          onFilter={onFilter}
          setting={setting}
          now={now}
        />
      </div>

      {open.deals.length > 0 ? (
        <OpenDeals
          deals={open.deals}
          summary={summary}
          programs={programs}
          isPartial={open.isPartial}
          filter={filter}
          onFilter={onFilter}
          now={now}
          setting={setting}
        />
      ) : (
        <section className="rounded-xl border bg-card text-card-foreground">
          {hasDeals ? (
            <SectionEmpty title="No open deals.">
              Every deal you worked, won or lost, is in All deals below.
            </SectionEmpty>
          ) : (
            <SectionEmpty title="No deals yet.">
              A deal opens here when someone books a call with you. Each one shows where it stands and its
              next step, and the panel above counts your month and your book.
            </SectionEmpty>
          )}
        </section>
      )}
    </div>
  );
}

/** Whether the closer has any deal at all: the lookup has nothing to find otherwise. */
export function useHasAnyDeal(): boolean | undefined {
  const open = useQuery(api.closer.pipelineDesk.getOpenDeals, {});
  return open === undefined ? undefined : open.programs.length > 0;
}
