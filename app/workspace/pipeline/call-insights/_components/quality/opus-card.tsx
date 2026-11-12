"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BAR_DEFINITIONS } from "@/convex/callInsights/eval/metrics";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import {
  COLUMN_HEAD,
  FIGURE_15,
  RowsSkeleton,
  StatusWord,
} from "@/app/workspace/reports/_components/report-ui";
import { getErrorMessage } from "@/lib/errors";
import { formatUsd } from "@/lib/callInsights/report-display";
import {
  JUDGE_DIMENSION_WORDS,
  REGRESSION_MODELS,
  barResultTone,
  barResultWords,
  countedWords,
  labelTitle,
  lowerBoundWords,
  shareWords,
  trustWords,
} from "@/lib/callInsights/quality-display";
import { cn } from "@/lib/utils";
import type { CallInsightsSettingsView } from "../call-insights-page-client";

type Job = NonNullable<CallInsightsSettingsView["job"]>;
type Report = FunctionReturnType<
  typeof api.callInsights.eval.reports.latestReports
>["reports"][number];

const DEFINITIONS = new Map(
  BAR_DEFINITIONS.map((definition) => [definition.key, definition]),
);

const CAL_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 @3xl:grid-cols-[minmax(0,9rem)_5.5rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)_8.5rem]";

/** "Opus is grading · 12 of 40 calls · $1.20 spent of $10.00", from the latest job row. */
function JobLine({ job, label }: { job: Job; label: string }) {
  const finished = job.done + job.failed + job.skipped;
  return (
    <p className="text-[13px] text-muted-foreground" role="status">
      <span className="font-medium text-foreground">
        {job.status === "running"
          ? label
          : `${label}: ${job.status === "done" ? "finished" : "canceled"}`}
      </span>{" "}
      ·{" "}
      <span className={cn(FIGURE_15, "text-sm text-foreground")}>
        {finished}
      </span>{" "}
      of{" "}
      <span className={cn(FIGURE_15, "text-sm text-foreground")}>
        {job.total}
      </span>{" "}
      calls
      {job.failed ? ` · ${job.failed} failed` : null}
      {job.skipped ? ` · ${job.skipped} skipped` : null} ·{" "}
      {formatUsd(job.spentUsd)} spent of {formatUsd(job.ceilingUsd)}
    </p>
  );
}

/**
 * Section 5, "Opus": have Opus grade the chosen test, see how often it agrees
 * with the admin on Calibration calls and whether that lets it stop a change,
 * and test a model change against the committed grades.
 */
export function OpusCard({
  campaign,
  job,
}: {
  campaign: string;
  job: Job | null;
}) {
  const { isAuthenticated } = useConvexAuth();
  const calibration = useQuery(
    api.callInsights.eval.judge.judgeCalibration,
    isAuthenticated ? { campaign } : "skip",
  );
  const startJudge = useMutation(api.callInsights.eval.judge.startJudgeJob);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = job?.status === "running";
  const judgeJob = job?.kind === "eval_judge" ? job : null;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const jobId = await startJudge({ campaign });
      if (jobId === null)
        toast.info(
          "Nothing for Opus to grade. It grades calls you have graded, and needs an eval allowance above $0.",
        );
      else toast.success("Opus is grading this test.");
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't start Opus."));
    } finally {
      setStarting(false);
    }
  };

  return (
    <DetailCard title="Opus">
      <p className="border-b px-4 py-3 text-sm leading-relaxed">
        Opus never passes a check. Where it agrees with you often enough, it is
        allowed to stop a prompt or model change until you look.
      </p>
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={starting || running}
            onClick={() => void start()}
          >
            {starting ? <Spinner data-icon="inline-start" /> : null}
            Have Opus grade this test
          </Button>
          <p className="text-[13px] text-muted-foreground">
            {running && job?.kind !== "eval_judge"
              ? "Another job is running. Start this when it ends."
              : "It reads your graded calls three times each and is charged to the eval allowance."}
          </p>
        </div>
        {judgeJob ? <JobLine job={judgeJob} label="Opus is grading" /> : null}
        {error ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </div>

      <h3 className="border-b bg-muted/40 px-4 py-1.5 text-[13px] font-semibold">
        Agreement on Calibration calls
      </h3>
      <div className="@container">
        {calibration === undefined ? (
          <RowsSkeleton
            rows={4}
            rowHeight="h-12"
            label="Loading Opus's agreement"
          />
        ) : calibration.dimensions.every((row) => row.calls === 0) ? (
          <SectionEmpty
            title="Opus hasn't graded any Calibration call yet."
            className="border-b"
          >
            Grade the Calibration calls, then have Opus grade this test.
          </SectionEmpty>
        ) : (
          <>
            <div
              aria-hidden="true"
              className={cn(CAL_GRID, "hidden border-b @3xl:grid")}
            >
              <span className={cn(COLUMN_HEAD, "px-0")}>Kind of item</span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>Calls</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Agrees with you</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>
                Planted mistakes caught
              </span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Same answer twice</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Role</span>
            </div>
            <ul
              aria-label="Opus's agreement by kind of item"
              className="border-b"
            >
              {calibration.dimensions.map((row) => {
                const bound = row.calls
                  ? lowerBoundWords(row.lowerBound)
                  : null;
                return (
                  <li
                    key={row.dimension}
                    className={cn(
                      CAL_GRID,
                      "min-h-12 border-b py-2 last:border-b-0",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {JUDGE_DIMENSION_WORDS[row.dimension] ?? row.dimension}
                      </p>
                      <p className="text-[13px] text-muted-foreground @3xl:hidden">
                        {row.calls} calls · agrees{" "}
                        {shareWords(row.agreement, row.calls)} · planted caught{" "}
                        {shareWords(row.plantedCaught, row.planted)} · same
                        twice {shareWords(row.stable, row.stabilityN)}
                      </p>
                    </div>
                    <p
                      className={cn(FIGURE_15, "hidden text-right @3xl:block")}
                    >
                      {row.calls}
                    </p>
                    <div className="hidden min-w-0 @3xl:block">
                      <p className="text-sm">
                        {shareWords(row.agreement, row.calls)}
                      </p>
                      {bound ? (
                        <p className="text-[13px] text-muted-foreground">
                          {bound}
                        </p>
                      ) : null}
                    </div>
                    <p className="hidden text-sm @3xl:block">
                      {shareWords(row.plantedCaught, row.planted)}
                    </p>
                    <p className="hidden text-sm @3xl:block">
                      {shareWords(row.stable, row.stabilityN)}
                    </p>
                    <div className="text-right @3xl:text-left">
                      <StatusWord
                        tone={row.trust === "may_block" ? "live" : "done"}
                      >
                        {trustWords(row.trust)}
                      </StatusWord>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
              {calibration.inventoryMisses.found +
                calibration.inventoryMisses.shared ===
              0
                ? "The reading missed none of the items you listed. "
                : `Of the items you listed that the reading missed, Opus's own blind list found ${calibration.inventoryMisses.found} and missed ${calibration.inventoryMisses.shared}. `}
              Income, suggested results and no-shows stay advisory.
            </p>
          </>
        )}
      </div>

      <RegressionSection campaign={campaign} job={job} />
    </DetailCard>
  );
}

/** "Test a change": re-read the graded calls with another model and list what moved. */
function RegressionSection({
  campaign,
  job,
}: {
  campaign: string;
  job: Job | null;
}) {
  const { isAuthenticated } = useConvexAuth();
  const reports = useQuery(
    api.callInsights.eval.reports.latestReports,
    isAuthenticated ? {} : "skip",
  );
  const startRegression = useMutation(
    api.callInsights.eval.regression.startRegression,
  );
  const [model, setModel] = useState<string>(REGRESSION_MODELS[0].value);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const format = useLocalFormat();

  const running = job?.status === "running";
  const regressionJob = job?.kind === "eval_regression" ? job : null;
  const report = (reports?.reports ?? [])
    .filter((candidate) => candidate.kind === "regression")
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const jobId = await startRegression({ campaign, candidate: { model } });
      if (jobId === null)
        toast.info(
          "Nothing to test. A change is tested on graded calls, and needs an eval allowance above $0.",
        );
      else toast.success("Testing the change.");
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't start the test."));
    } finally {
      setStarting(false);
    }
  };

  const modelLabel = (value?: string) =>
    REGRESSION_MODELS.find((option) => option.value === value)?.label ?? value;

  return (
    <section aria-label="Test a change">
      <h3 className="border-b bg-muted/40 px-4 py-1.5 text-[13px] font-semibold">
        Test a change
      </h3>
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <p className="text-[13px] text-muted-foreground">
          Reads this test&apos;s graded calls again with another model and
          compares the new reading with your grades. Nothing it reads is shown
          on meetings.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="regression-model"
              className="text-[13px] text-muted-foreground"
            >
              Model
            </label>
            <NativeSelect
              id="regression-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {REGRESSION_MODELS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mb-0.5"
            disabled={starting || running}
            onClick={() => void start()}
          >
            {starting ? <Spinner data-icon="inline-start" /> : null}
            Start
          </Button>
        </div>
        {regressionJob ? (
          <JobLine job={regressionJob} label="Testing the change" />
        ) : null}
        {running && !regressionJob ? (
          <p className="text-[13px] text-muted-foreground">
            Another job is running. Start this when it ends.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </div>
      {reports === undefined ? (
        <RowsSkeleton rows={3} rowHeight="h-11" label="Loading the last test" />
      ) : !report ? (
        <SectionEmpty title="No change tested yet." />
      ) : (
        <>
          <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
            Last test: {modelLabel(report.config?.model)}
            {report.campaign ? ` on ${report.campaign}` : null},{" "}
            {format(report.createdAt, "MMM d, h:mm a")} ·{" "}
            {formatUsd(report.spentMicroUsd / 1e6)} spent
          </p>
          <RegressionBars report={report} />
          <RegressionChanges
            reportId={report._id}
            campaign={report.campaign ?? campaign}
          />
        </>
      )}
    </section>
  );
}

function RegressionBars({ report }: { report: Report }) {
  return (
    <ul aria-label="Checks after the change" className="border-b">
      {report.bars.map((bar) => (
        <li
          key={bar.key}
          className="flex min-h-11 items-start justify-between gap-3 border-b px-4 py-2 last:border-b-0"
        >
          <div className="min-w-0">
            <p className="text-sm">
              {DEFINITIONS.get(bar.key)?.label ??
                (bar.key === "regression_money_review"
                  ? "Money changes reviewed by a person"
                  : bar.key)}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {countedWords(bar)} · {bar.wrong} wrong · {bar.rule}
            </p>
          </div>
          <StatusWord tone={barResultTone(bar.result)}>
            {barResultWords(bar.result)}
          </StatusWord>
        </li>
      ))}
    </ul>
  );
}

/** Every missing, changed and new item by call, key and line. Typed identifiers only, no quotes. */
function RegressionChanges({
  reportId,
  campaign,
}: {
  reportId: Id<"callInsightEvalReports">;
  campaign: string;
}) {
  const { isAuthenticated } = useConvexAuth();
  const detail = useQuery(
    api.callInsights.eval.regression.regressionDetail,
    isAuthenticated ? { reportId } : "skip",
  );
  const cases = useQuery(
    api.callInsights.eval.cases.cases,
    isAuthenticated ? { campaign } : "skip",
  );
  const names = new Map(
    (cases?.cases ?? []).map((row) => [row.caseId, row.leadName]),
  );

  if (detail === undefined)
    return (
      <RowsSkeleton rows={3} rowHeight="h-11" label="Loading what changed" />
    );
  const moved = detail.filter(
    (row) => row.missing.length || row.changed.length || row.new.length,
  );
  if (moved.length === 0)
    return <SectionEmpty title="Nothing moved against your grades." />;

  const groups = [
    { key: "missing", label: "Missing" },
    { key: "changed", label: "Changed" },
    { key: "new", label: "New" },
  ] as const;

  return (
    <ul aria-label="What changed, by call">
      {moved.map((row) => (
        <li
          key={row.caseId}
          className="flex flex-col gap-1 border-b px-4 py-2.5 last:border-b-0"
        >
          <p translate="no" className="text-sm font-medium">
            {names.get(row.caseId) ?? "A graded call"}
          </p>
          {groups.map((group) =>
            row[group.key].length ? (
              <p key={group.key} className="text-[13px]">
                <span className="text-muted-foreground">{group.label}: </span>
                {row[group.key]
                  .map((item) => `${labelTitle(item)} (${item.key})`)
                  .join("; ")}
              </p>
            ) : null,
          )}
        </li>
      ))}
    </ul>
  );
}
