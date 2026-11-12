"use client";

import { useState } from "react";
import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  COLUMN_HEAD,
  ReportNote,
  RowsSkeleton,
  StatusWord,
} from "@/app/workspace/reports/_components/report-ui";
import {
  TEST_SPLITS,
  caseActionWords,
  caseStatusTone,
  caseStatusWords,
  splitWords,
  type TestSplit,
} from "@/lib/callInsights/quality-display";
import { cn } from "@/lib/utils";

export const gradingHref = (caseId: string) =>
  `/workspace/pipeline/call-insights/quality/${caseId}`;

const SPLIT_ORDER: Record<string, number> = {
  dev: 0,
  calib: 1,
  holdout: 2,
  drift_random: 3,
  drift_risk: 4,
};
const STATUS_ORDER: Record<string, number> = {
  list_committed: 0,
  to_read: 1,
  labels_committed: 2,
  closed: 3,
};

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 @3xl:grid-cols-[minmax(0,1fr)_8rem_7rem_4rem]";

/**
 * Section 2, "Calls to grade": the chosen test's calls, half-graded ones
 * first, each opening the grading screen.
 */
export function CasesCard({ campaign }: { campaign: string }) {
  const [split, setSplit] = useState<TestSplit | "all">("all");
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.callInsights.eval.cases.cases,
    isAuthenticated
      ? {
          campaign,
          ...(split === "all" ? {} : { split }),
        }
      : "skip",
  );
  const { data, reloading } = useKeptWhileLoading(
    result,
    `${campaign}:${split}`,
  );
  const format = useLocalFormat();

  const rows = data
    ? [...data.cases].sort(
        (a, b) =>
          (SPLIT_ORDER[a.split] ?? 9) - (SPLIT_ORDER[b.split] ?? 9) ||
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
          b.scheduledAt - a.scheduledAt,
      )
    : undefined;

  return (
    <DetailCard
      title="Calls to grade"
      meta={
        <NativeSelect
          size="sm"
          aria-label="Show calls from one split"
          value={split}
          onChange={(event) =>
            setSplit(event.target.value as TestSplit | "all")
          }
        >
          <NativeSelectOption value="all">All splits</NativeSelectOption>
          {TEST_SPLITS.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {splitWords(option)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      }
    >
      {data?.capped ? (
        <ReportNote lead="Partial.">This list stops at 100 calls.</ReportNote>
      ) : null}
      <div className="@container">
        {rows === undefined ? (
          <RowsSkeleton
            rows={6}
            rowHeight="h-14"
            label="Loading calls to grade"
          />
        ) : rows.length === 0 ? (
          <SectionEmpty
            title={
              split === "all"
                ? "This test has no calls."
                : `No ${splitWords(split)} calls in this test.`
            }
          >
            {split === "all"
              ? "No read call could be used when it started."
              : null}
          </SectionEmpty>
        ) : (
          <div
            aria-busy={reloading || undefined}
            className={cn(
              "transition-opacity duration-200",
              reloading && "opacity-60",
            )}
          >
            <div
              aria-hidden="true"
              className={cn(ROW_GRID, "hidden border-b @3xl:grid")}
            >
              <span className={cn(COLUMN_HEAD, "px-0")}>Call</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Split</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Status</span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")} />
            </div>
            <ul aria-label="Calls to grade">
              {rows.map((row) => (
                <li
                  key={row.caseId}
                  className={cn(
                    ROW_GRID,
                    "relative min-h-14 border-b py-2.5 last:border-b-0 hover:bg-muted/60",
                  )}
                >
                  <div className="min-w-0">
                    <Link
                      href={gradingHref(row.caseId)}
                      translate="no"
                      className="block truncate font-medium text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                    >
                      <span className="sr-only">
                        {caseActionWords(row.status)}{" "}
                      </span>
                      {row.leadName}
                    </Link>
                    <p className="truncate text-[13px] text-muted-foreground">
                      <span className="font-condensed text-sm font-semibold tabular-nums">
                        {row.scheduledAt
                          ? format(row.scheduledAt, "MMM d, h:mm a")
                          : "—"}
                      </span>
                      <span className="@3xl:hidden">
                        {" "}
                        · {splitWords(row.split)}
                      </span>
                      {row.listSkipped ? " · own list skipped" : null}
                      {row.judgeExposed ? " · reopened after Opus" : null}
                    </p>
                  </div>
                  <p className="hidden text-sm @3xl:block">
                    {splitWords(row.split)}
                  </p>
                  <div className="text-right @3xl:text-left">
                    <StatusWord tone={caseStatusTone(row.status)}>
                      {caseStatusWords(row.status)}
                    </StatusWord>
                  </div>
                  <span
                    aria-hidden="true"
                    className="hidden text-right text-sm font-semibold underline decoration-foreground/40 underline-offset-[3px] @3xl:block"
                  >
                    {caseActionWords(row.status)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </DetailCard>
  );
}
