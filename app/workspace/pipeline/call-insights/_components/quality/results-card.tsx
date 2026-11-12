"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { BAR_DEFINITIONS } from "@/convex/callInsights/eval/metrics";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import {
  COLUMN_HEAD,
  FIGURE_15,
  ReportNote,
  RowsSkeleton,
  StatusWord,
} from "@/app/workspace/reports/_components/report-ui";
import { getErrorMessage } from "@/lib/errors";
import {
  REPORT_GROUPS,
  TEST_SPLITS,
  barResultTone,
  barResultWords,
  capabilityWords,
  countedWords,
  lowerBoundWords,
  needsMoreWords,
  splitWords,
  type TestSplit,
} from "@/lib/callInsights/quality-display";
import { cn } from "@/lib/utils";
import { SEGMENT, SEGMENT_GROUP } from "./grading-parts";

const DEFINITIONS = new Map(
  BAR_DEFINITIONS.map((definition) => [definition.key, definition]),
);

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 @4xl:grid-cols-[minmax(0,1.3fr)_7.5rem_3.5rem_minmax(0,1fr)_minmax(0,11rem)_minmax(0,0.9fr)]";

/**
 * Section 4, "Results": for the chosen test and split, work out the bars and
 * show the newest ones grouped by What they said, Suggested results and
 * No-show, with what each bar keeps off until it passes. Above them, which
 * switches the holdout results certify.
 */
export function ResultsCard({ campaign }: { campaign: string }) {
  const [split, setSplit] = useState<TestSplit>("dev");
  const { isAuthenticated } = useConvexAuth();
  const reports = useQuery(
    api.callInsights.eval.reports.latestReports,
    isAuthenticated ? {} : "skip",
  );
  const capabilities = useQuery(
    api.callInsights.eval.reports.capabilityStatus,
    isAuthenticated ? {} : "skip",
  );
  const buildReport = useMutation(api.callInsights.eval.reports.buildReport);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const format = useLocalFormat();

  const shown = (reports?.reports ?? []).filter(
    (report) =>
      report.split === split &&
      (report.kind === "quality" ||
        report.kind === "suggestions" ||
        report.kind === "no_show"),
  );
  const newest = shown.reduce<number | null>(
    (at, report) =>
      at === null || report.createdAt > at ? report.createdAt : at,
    null,
  );
  const otherCampaigns = [
    ...new Set(
      shown
        .map((report) => report.campaign)
        .filter((name) => name && name !== campaign),
    ),
  ];

  const workOut = async () => {
    setWorking(true);
    setError(null);
    try {
      for (const kind of ["quality", "suggestions", "no_show"] as const)
        await buildReport({ campaign, split, kind });
      toast.success(`Results worked out for ${splitWords(split)}.`);
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't work out the results."));
    } finally {
      setWorking(false);
    }
  };

  return (
    <DetailCard
      title="Results"
      meta={
        <ToggleGroup
          type="single"
          value={split}
          onValueChange={(value) => {
            if (value) setSplit(value as TestSplit);
          }}
          aria-label="Split"
          className={SEGMENT_GROUP}
        >
          {TEST_SPLITS.map((option) => (
            <ToggleGroupItem key={option} value={option} className={SEGMENT}>
              {splitWords(option)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <CapabilityRows capabilities={capabilities} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
          {newest === null
            ? `No results for ${splitWords(split)} yet.`
            : `${splitWords(split)} results worked out ${format(newest, "MMM d, h:mm a")}.`}
          {otherCampaigns.length
            ? ` Some come from ${otherCampaigns.join(", ")}.`
            : null}
          {split === "holdout"
            ? " Only Holdout results decide the switches."
            : null}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={() => void workOut()}
        >
          {working ? <Spinner data-icon="inline-start" /> : null}
          Work out the results
        </Button>
        {error ? (
          <p role="alert" className="basis-full text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </div>
      {reports?.capped ? (
        <ReportNote lead="Partial.">
          Not every saved result was read.
        </ReportNote>
      ) : null}

      <div className="@container">
        {reports === undefined ? (
          <RowsSkeleton rows={6} rowHeight="h-14" label="Loading results" />
        ) : shown.length === 0 ? (
          <SectionEmpty title={`No ${splitWords(split)} results yet.`}>
            Grade some calls, then work out the results.
          </SectionEmpty>
        ) : (
          <>
            <div
              aria-hidden="true"
              className={cn(ROW_GRID, "hidden border-b @4xl:grid")}
            >
              <span className={cn(COLUMN_HEAD, "px-0")}>What is measured</span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Counted
              </span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>Wrong</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Rule</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Result</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>
                Stays off until it passes
              </span>
            </div>
            {REPORT_GROUPS.map((group) => {
              const report = shown.find(
                (candidate) => candidate.kind === group.kind,
              );
              return (
                <section key={group.kind} aria-label={group.label}>
                  <h3 className="border-b bg-muted/40 px-4 py-1.5 text-[13px] font-semibold">
                    {group.label}
                  </h3>
                  {!report || report.bars.length === 0 ? (
                    <SectionEmpty
                      title="Not worked out yet."
                      className="border-b"
                    />
                  ) : (
                    <ul
                      aria-label={`${group.label} bars`}
                      className="border-b last:border-b-0"
                    >
                      {report.bars.map((bar) => {
                        const definition = DEFINITIONS.get(bar.key);
                        const needs =
                          bar.result === "inconclusive"
                            ? needsMoreWords(bar, definition?.callFloor ?? 0)
                            : null;
                        const bound = lowerBoundWords(bar.lowerBound);
                        return (
                          <li
                            key={bar.key}
                            className={cn(
                              ROW_GRID,
                              "min-h-14 border-b py-2.5 last:border-b-0",
                            )}
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {definition?.label ?? bar.key}
                              </p>
                              <p className="text-[13px] text-muted-foreground @4xl:hidden">
                                {countedWords(bar)} · {bar.wrong} wrong ·{" "}
                                {bar.rule}
                              </p>
                              {definition ? (
                                <p className="text-[13px] text-muted-foreground @4xl:hidden">
                                  Keeps off: {definition.capability}
                                </p>
                              ) : null}
                            </div>
                            <p
                              className={cn(
                                FIGURE_15,
                                "hidden text-right @4xl:block",
                              )}
                            >
                              {bar.n}
                              <span className="block text-[13px] font-normal text-muted-foreground">
                                {bar.calls} {bar.calls === 1 ? "call" : "calls"}
                              </span>
                            </p>
                            <p
                              className={cn(
                                FIGURE_15,
                                "hidden text-right @4xl:block",
                                bar.wrong === 0 && "text-muted-foreground",
                              )}
                            >
                              {bar.wrong}
                            </p>
                            <p className="hidden text-[13px] @4xl:block">
                              {bar.rule}
                            </p>
                            <div className="min-w-0 text-right @4xl:text-left">
                              <StatusWord tone={barResultTone(bar.result)}>
                                {barResultWords(bar.result)}
                              </StatusWord>
                              {needs ? (
                                <p className="text-[13px] text-muted-foreground">
                                  {needs}
                                </p>
                              ) : null}
                              {bound ? (
                                <p className="text-[13px] text-muted-foreground">
                                  {bound}
                                </p>
                              ) : null}
                            </div>
                            <p className="hidden text-[13px] text-muted-foreground @4xl:block">
                              {bar.result === "pass"
                                ? "Nothing"
                                : (definition?.capability ?? "—")}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
    </DetailCard>
  );
}

/** Which switches the newest Holdout results certify, one status word each. */
function CapabilityRows({
  capabilities,
}: {
  capabilities:
    | FunctionReturnType<typeof api.callInsights.eval.reports.capabilityStatus>
    | undefined;
}) {
  if (capabilities === undefined)
    return (
      <RowsSkeleton rows={2} rowHeight="h-9" label="Loading switch checks" />
    );
  if (capabilities.capabilities.length === 0) return null;
  return (
    <div className="border-b">
      <h3 className="border-b bg-muted/40 px-4 py-1.5 text-[13px] font-semibold">
        Switches, from Holdout results
      </h3>
      <ul aria-label="Switches">
        {capabilities.capabilities.map((capability) => (
          <li
            key={capability.key}
            className="flex min-h-9 items-center justify-between gap-3 border-b px-4 py-1.5 last:border-b-0"
          >
            <span className="text-sm">{capabilityWords(capability.key)}</span>
            <StatusWord tone={barResultTone(capability.result)}>
              {barResultWords(capability.result)}
            </StatusWord>
          </li>
        ))}
      </ul>
    </div>
  );
}
