"use client";

import { useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  BarList,
  ChartLegend,
  FIGURE_15,
  LABEL,
  REPORT_PAIR,
  ReportCard,
  ReportNote,
  RowsSkeleton,
  type BarListRow,
} from "@/app/workspace/reports/_components/report-ui";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { categoryLabel } from "@/lib/callInsights/taxonomy";
import {
  NO_SHOW_TIER_ORDER,
  callCount,
  incomeBandOrder,
  incomeBandWords,
  noShowTierWords,
  percentOf,
  reasonWords,
} from "@/lib/callInsights/report-display";
import { cn } from "@/lib/utils";

type Summary = NonNullable<
  FunctionReturnType<typeof api.callInsights.reports.summary>
>;
type Days = 30 | 90;

// The objection bar's three parts, from the chart tokens (DESIGN.md, Charts).
const RESOLUTION_PARTS = [
  { key: "resolved", label: "Resolved", color: "var(--chart-2)" },
  { key: "unresolved", label: "Open", color: "var(--chart-4)" },
  { key: "unknown", label: "Unknown", color: "var(--chart-5)" },
] as const;

/**
 * What prospects said across read calls in the last 30 or 90 days: coverage,
 * objections with how they ended, struggles, goals, income bands and no-show
 * tiers. Only confirmed and restored items count.
 */
export function ReportsTab() {
  const [days, setDays] = useState<Days>(30);
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.callInsights.reports.summary,
    isAuthenticated ? { days } : "skip",
  );
  const { data, phrase, reloading } = useKeptWhileLoading(
    result,
    `last ${days} days`,
  );

  return (
    <div className="flex flex-col gap-3.5 short:gap-3">
      <DetailCard
        title="Reports"
        meta={
          <ToggleGroup
            type="single"
            size="sm"
            value={String(days)}
            onValueChange={(next) => {
              if (next) setDays(Number(next) as Days);
            }}
            aria-label="Range"
            className="h-[30px] rounded-[7px] bg-muted p-0.5"
          >
            {([30, 90] as const).map((option) => (
              <ToggleGroupItem
                key={option}
                value={String(option)}
                className="h-full rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]"
              >
                {option} days
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      >
        <p className="px-4 py-2.5 text-[13px] text-muted-foreground">
          Counts come from calls that were read. Items marked Not confirmed
          aren&apos;t counted.
          {data?.capped ? (
            <span className="font-medium text-foreground">
              {" "}
              Showing part of the range.
            </span>
          ) : null}
        </p>
      </DetailCard>

      {data === undefined ? (
        <div className={REPORT_PAIR}>
          <ReportCard title="Coverage">
            <RowsSkeleton rows={4} label="Loading coverage" />
          </ReportCard>
          <ReportCard title="Objections">
            <RowsSkeleton rows={4} label="Loading objections" />
          </ReportCard>
        </div>
      ) : data === null ? (
        <section className={CARD}>
          <SectionEmpty title="Only owners and admins can see these reports." />
        </section>
      ) : (
        <ReportBody summary={data} phrase={phrase} reloading={reloading} />
      )}
    </div>
  );
}

function ReportBody({
  summary,
  phrase,
  reloading,
}: {
  summary: Summary;
  phrase: string;
  reloading: boolean;
}) {
  const { coverage } = summary;
  const read = coverage.read;

  return (
    <>
      <div className={REPORT_PAIR}>
        <CoverageCard summary={summary} phrase={phrase} reloading={reloading} />
        <NoShowCard summary={summary} phrase={phrase} reloading={reloading} />
      </div>
      {read === 0 ? (
        <section className={CARD}>
          <SectionEmpty title={`No calls were read in the ${phrase}.`}>
            Objections, struggles, goals and income appear once a matched call
            is read.
          </SectionEmpty>
        </section>
      ) : (
        <>
          <ObjectionsCard summary={summary} reloading={reloading} />
          <div className={REPORT_PAIR}>
            <CategoryCard
              title="Struggles"
              rows={summary.struggles}
              read={read}
              reloading={reloading}
              empty="No struggle was named on a read call."
            />
            <CategoryCard
              title="Goals"
              rows={summary.goals}
              read={read}
              reloading={reloading}
              empty="No goal was named on a read call."
            />
          </div>
          <IncomeCard summary={summary} reloading={reloading} />
        </>
      )}
    </>
  );
}

function CoverageCard({
  summary,
  phrase,
  reloading,
}: {
  summary: Summary;
  phrase: string;
  reloading: boolean;
}) {
  const { coverage } = summary;
  const skipped = Object.entries(coverage.skippedByReason).sort(
    (a, b) => b[1] - a[1],
  );
  const counts: Array<Omit<BarListRow, "display">> = [
    { key: "read", label: "Read", value: coverage.read },
    {
      key: "waiting",
      label: "Waiting for room under the limit",
      value: coverage.waiting,
    },
    { key: "failed", label: "Failed", value: coverage.failed },
    ...skipped.map(([reason, count]) => ({
      key: `skipped:${reason}`,
      label: reasonWords(reason),
      meta: "Not read",
      value: count,
    })),
  ];
  const rows: BarListRow[] = counts.map((row) => ({
    ...row,
    display: (
      <>
        {row.value}
        <span className="ml-1.5 font-sans text-[13px] font-normal text-muted-foreground">
          {percentOf(row.value, coverage.matched)}
        </span>
      </>
    ),
  }));

  return (
    <ReportCard
      title="Coverage"
      meta={`${callCount(coverage.matched)} matched`}
      reloading={reloading}
    >
      {coverage.matched === 0 ? (
        <SectionEmpty
          title={`No call was matched to a meeting in the ${phrase}.`}
        />
      ) : (
        <>
          <ReportNote>
            A call with a new attempt waiting or failed can also count as read.
          </ReportNote>
          <BarList
            rows={rows}
            label="Matched calls by reading status"
            labelColumn="16rem"
          />
        </>
      )}
    </ReportCard>
  );
}

function NoShowCard({
  summary,
  phrase,
  reloading,
}: {
  summary: Summary;
  phrase: string;
  reloading: boolean;
}) {
  const entries = Object.entries(summary.noShowTiers);
  const order = (tier: string) => {
    const index = (NO_SHOW_TIER_ORDER as readonly string[]).indexOf(tier);
    return index === -1 ? NO_SHOW_TIER_ORDER.length : index;
  };
  const rows: BarListRow[] = entries
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([tier, count]) => ({
      key: tier,
      label: noShowTierWords(tier),
      value: count,
      display: count,
    }));

  return (
    <ReportCard
      title="No-show tiers"
      meta="Matched calls"
      reloading={reloading}
    >
      {rows.length === 0 ? (
        <SectionEmpty title={`No no-show reading in the ${phrase}.`} />
      ) : (
        <BarList rows={rows} label="Matched calls by no-show tier" />
      )}
    </ReportCard>
  );
}

function ObjectionsCard({
  summary,
  reloading,
}: {
  summary: Summary;
  reloading: boolean;
}) {
  const read = summary.coverage.read;
  const max = Math.max(...summary.objections.map((row) => row.calls), 0);

  return (
    <ReportCard
      title="Objections"
      meta={`Share of ${callCount(read)} read · a call counts once per objection`}
      reloading={reloading}
    >
      {summary.objections.length === 0 ? (
        <SectionEmpty title="No objection was raised on a read call." />
      ) : (
        <>
          <ChartLegend
            items={RESOLUTION_PARTS.map((part) => ({
              key: part.key,
              label: part.label,
              color: part.color,
            }))}
          />
          <ul aria-label="Objections by how they ended" className="border-t">
            {summary.objections.map((row) => {
              const known = row.resolved + row.unresolved + row.unknown;
              return (
                <li
                  key={row.category}
                  className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 last:border-b-0 @lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {row.label || categoryLabel("objection", row.category)}
                    </p>
                    <p className="truncate text-[13px] text-muted-foreground">
                      Main on {row.primaryCalls} · {row.resolved} resolved ·{" "}
                      {row.unresolved} open · {row.unknown} unknown
                    </p>
                  </div>
                  <div
                    aria-hidden="true"
                    className="order-last col-span-2 flex h-2 overflow-hidden rounded-[3px] bg-muted @lg:order-none @lg:col-span-1"
                  >
                    <div
                      className="flex h-full"
                      style={{
                        width: max > 0 ? `${(row.calls / max) * 100}%` : 0,
                      }}
                    >
                      {RESOLUTION_PARTS.map((part) => (
                        <div
                          key={part.key}
                          className="h-full"
                          style={{
                            width:
                              known > 0
                                ? `${(row[part.key] / known) * 100}%`
                                : 0,
                            background: part.color,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <p className={cn(FIGURE_15, "text-right whitespace-nowrap")}>
                    {row.calls}
                    <span className="ml-1.5 font-sans text-[13px] font-normal text-muted-foreground">
                      {percentOf(row.calls, read)}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </ReportCard>
  );
}

function CategoryCard({
  title,
  rows,
  read,
  reloading,
  empty,
}: {
  title: string;
  rows: Summary["struggles"];
  read: number;
  reloading: boolean;
  empty: string;
}) {
  return (
    <ReportCard
      title={title}
      meta={`Share of ${callCount(read)} read`}
      reloading={reloading}
    >
      {rows.length === 0 ? (
        <SectionEmpty title={empty} />
      ) : (
        <BarList
          label={`${title} by calls that named them`}
          rows={rows.map((row) => ({
            key: row.category,
            label: row.label,
            value: row.calls,
            display: (
              <>
                {row.calls}
                <span className="ml-1.5 font-sans text-[13px] font-normal text-muted-foreground">
                  {percentOf(row.calls, read)}
                </span>
              </>
            ),
          }))}
        />
      )}
    </ReportCard>
  );
}

function IncomeCard({
  summary,
  reloading,
}: {
  summary: Summary;
  reloading: boolean;
}) {
  const kinds = new Map<
    string,
    { label: string; rows: Summary["incomeBands"] }
  >();
  for (const row of summary.incomeBands) {
    const group = kinds.get(row.kind) ?? { label: row.label, rows: [] };
    group.rows.push(row);
    kinds.set(row.kind, group);
  }

  return (
    <ReportCard
      title="Income bands"
      meta="Current income · USD a month · a call counts once per kind"
      reloading={reloading}
    >
      {kinds.size === 0 ? (
        <SectionEmpty title="No current income was stated on a read call." />
      ) : (
        [...kinds].map(([kind, group]) => (
          <div key={kind} className="border-b last:border-b-0">
            <p className={cn(LABEL, "px-4 pt-2.5 pb-1")}>{group.label}</p>
            <BarList
              label={`${group.label} by band`}
              labelColumn="13rem"
              rows={[...group.rows]
                .sort(
                  (a, b) => incomeBandOrder(a.band) - incomeBandOrder(b.band),
                )
                .map((row) => ({
                  key: row.band,
                  label: incomeBandWords(kind, row.band),
                  value: row.calls,
                  display: row.calls,
                }))}
            />
          </div>
        ))
      )}
    </ReportCard>
  );
}
