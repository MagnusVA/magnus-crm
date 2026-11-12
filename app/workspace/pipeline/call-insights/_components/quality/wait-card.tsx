"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
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
  lateStartWords,
  parseArrivalMinutes,
  upperBoundWords,
} from "@/lib/callInsights/quality-display";
import { cn } from "@/lib/utils";
import type { ConfirmRequest } from "../confirm-dialog";

const ConfirmDialog = dynamic(() => import("../confirm-dialog"));

type UnresolvedCall = FunctionReturnType<
  typeof api.callInsights.eval.waitStudy.waitStudy
>["unresolvedCalls"][number];

const PAGE = 10;

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 @3xl:grid-cols-[4.5rem_6rem_6rem_6rem_6.5rem_6rem_minmax(0,1fr)]";

/**
 * Section 6, "No-show wait": the rule, the 5, 7 and 10-minute waits measured
 * on held calls, the calls nobody can tell about yet with a way to say when
 * the prospect arrived, and "Use this wait" for a wait that passes.
 */
export function WaitCard({ currentWait }: { currentWait: number | undefined }) {
  const { isAuthenticated } = useConvexAuth();
  const study = useQuery(
    api.callInsights.eval.waitStudy.waitStudy,
    isAuthenticated ? {} : "skip",
  );
  const measured = study?.waits.some((wait) => wait.n > 0) ?? false;
  const updateSettings = useMutation(api.callInsights.admin.updateSettings);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const askUse = (minutes: number) =>
    setConfirm({
      title: `Use a ${minutes}-minute wait?`,
      description: `A no-show can be confirmed in one step only when the closer waited ${minutes} minutes after the start.`,
      note: "A person still confirms every no-show.",
      confirmLabel: "Use this wait",
      pendingLabel: "Saving…",
      run: async () => {
        await updateSettings({ noShowWaitMinutes: minutes });
        toast.success(`No-show wait set to ${minutes} minutes.`);
      },
    });

  return (
    <DetailCard
      title="No-show wait"
      meta={currentWait ? `In use: ${currentWait} minutes` : "No wait set"}
    >
      <p className="border-b px-4 py-3 text-sm leading-relaxed">
        A no-show can be confirmed in one step only when the closer waited long
        enough. A wait passes when at most 5% of prospects who did show up
        arrived later than it, measured on at least 59 held calls with none
        late.
      </p>
      {study?.capped ? (
        <ReportNote lead="Partial.">
          Only the oldest 500 calls since Call insights was turned on were read.
        </ReportNote>
      ) : null}
      <div className="@container">
        {study === undefined ? (
          <RowsSkeleton
            rows={3}
            rowHeight="h-12"
            label="Loading the no-show wait"
          />
        ) : (
          <>
            <div
              aria-hidden="true"
              className={cn(ROW_GRID, "hidden border-b @3xl:grid")}
            >
              <span className={cn(COLUMN_HEAD, "px-0")}>Wait</span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Held calls
              </span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Arrived later
              </span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Can&apos;t tell
              </span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Upper bound
              </span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Result</span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")} />
            </div>
            <ul aria-label="Waits">
              {study.waits.map((wait) => {
                const inUse = currentWait === wait.w;
                return (
                  <li
                    key={wait.w}
                    className={cn(ROW_GRID, "min-h-12 border-b py-2")}
                  >
                    <div className="min-w-0">
                      <p className={cn(FIGURE_15)}>{wait.w} min</p>
                      <p className="text-[13px] text-muted-foreground @3xl:hidden">
                        {wait.n} of {study.needed} held calls · {wait.late}{" "}
                        later · {wait.unresolved} can&apos;t tell · bound{" "}
                        {upperBoundWords(wait.upperBound)}
                      </p>
                    </div>
                    <p
                      className={cn(FIGURE_15, "hidden text-right @3xl:block")}
                    >
                      {wait.n}
                      <span className="text-[13px] font-normal text-muted-foreground">
                        {" "}
                        of {study.needed}
                      </span>
                    </p>
                    <p
                      className={cn(
                        FIGURE_15,
                        "hidden text-right @3xl:block",
                        wait.late === 0 && "text-muted-foreground",
                      )}
                    >
                      {wait.late}
                    </p>
                    <p
                      className={cn(
                        FIGURE_15,
                        "hidden text-right @3xl:block",
                        wait.unresolved === 0 && "text-muted-foreground",
                      )}
                    >
                      {wait.unresolved}
                    </p>
                    <p
                      className={cn(FIGURE_15, "hidden text-right @3xl:block")}
                    >
                      {upperBoundWords(wait.upperBound)}
                    </p>
                    <div className="hidden @3xl:block">
                      <StatusWord tone={wait.pass ? "live" : "owed"}>
                        {wait.pass ? "Passes" : "Not yet"}
                      </StatusWord>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <StatusWord
                        tone={wait.pass ? "live" : "owed"}
                        className="@3xl:hidden"
                      >
                        {wait.pass ? "Passes" : "Not yet"}
                      </StatusWord>
                      {inUse ? (
                        <span className="text-[13px] text-muted-foreground">
                          In use
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!wait.pass}
                          onClick={() => askUse(wait.w)}
                        >
                          Use this wait
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
              {measured ? `${lateStartWords(study.leftCensoredShare)} ` : null}
              Calls nobody can tell about count as arriving later.
            </p>
            <UnresolvedCalls
              calls={study.unresolvedCalls}
              measured={measured}
            />
          </>
        )}
      </div>
      {confirm ? (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      ) : null}
    </DetailCard>
  );
}

/** The held calls whose arrival can't be told from the recording, a page at a time. */
function UnresolvedCalls({
  calls,
  measured,
}: {
  calls: UnresolvedCall[];
  measured: boolean;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(calls.length / PAGE));
  const current = Math.min(page, pageCount - 1);
  const shown = calls.slice(current * PAGE, current * PAGE + PAGE);

  return (
    <section aria-label="Calls that can't tell">
      <h3 className="border-b bg-muted/40 px-4 py-1.5 text-[13px] font-semibold">
        Can&apos;t tell when the prospect arrived
      </h3>
      {calls.length === 0 ? (
        <SectionEmpty
          title={
            measured
              ? "Every measured call shows when the prospect arrived."
              : "No held calls have been measured yet."
          }
        />
      ) : (
        <>
          <ul aria-label="Calls to confirm">
            {shown.map((call) => (
              <ArrivalRow key={call.recordingId} call={call} />
            ))}
          </ul>
          {pageCount > 1 ? (
            <DetailCardFooter>
              <span className="text-[13px] font-normal">
                {calls.length} calls · page {current + 1} of {pageCount}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={current >= pageCount - 1}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </Button>
              </div>
            </DetailCardFooter>
          ) : null}
        </>
      )}
    </section>
  );
}

/** One call: who and when, and "When did the prospect arrive?" in minutes after the start, or Don't know. */
function ArrivalRow({ call }: { call: UnresolvedCall }) {
  const confirmArrival = useMutation(
    api.callInsights.eval.waitStudy.confirmArrival,
  );
  const format = useLocalFormat();
  const [minutes, setMinutes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `arrival-${call.recordingId}`;

  const save = async (value: number | null) => {
    setPending(true);
    setError(null);
    try {
      await confirmArrival({
        recordingId: call.recordingId,
        arrivedMinutesAfterStart: value,
      });
      if (value === null) toast.success("Left as can't tell.");
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the arrival."));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 border-b px-4 py-2.5 last:border-b-0 @3xl:flex-row @3xl:items-center @3xl:gap-4">
      <div className="min-w-0 flex-1">
        <Link
          href={`/workspace/pipeline/meetings/${call.meetingId}`}
          translate="no"
          className="block truncate font-medium text-foreground underline-offset-[3px] hover:underline"
        >
          {call.leadName}
        </Link>
        <p className="font-condensed text-sm font-semibold text-muted-foreground tabular-nums">
          {format(call.scheduledAt, "MMM d, h:mm a")}
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = parseArrivalMinutes(minutes);
          if (value === null) {
            setError(
              "Enter minutes after the start, such as 3, or -1 for early.",
            );
            return;
          }
          void save(value);
        }}
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor={inputId}
            className="text-[13px] text-muted-foreground"
          >
            When did the prospect arrive?
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              inputMode="decimal"
              className="h-8 w-20 font-condensed text-[15px] tabular-nums"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              aria-describedby={`${inputId}-unit`}
            />
            <span
              id={`${inputId}-unit`}
              className="text-[13px] text-muted-foreground"
            >
              minutes after the start
            </span>
          </div>
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => void save(null)}
        >
          Don&apos;t know
        </Button>
        {error ? (
          <p role="alert" className="basis-full text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </form>
    </li>
  );
}
