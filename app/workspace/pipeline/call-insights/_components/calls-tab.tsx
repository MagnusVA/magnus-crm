"use client";

import { useState } from "react";
import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { RunStatus } from "@/convex/callInsights/validators";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  COLUMN_HEAD,
  FIGURE_15,
  RowsSkeleton,
  StatusWord,
} from "@/app/workspace/reports/_components/report-ui";
import {
  CALL_STATUS_FILTERS,
  callStatusTone,
  callStatusWord,
  reasonWords,
} from "@/lib/callInsights/report-display";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | RunStatus;

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_5.5rem_5.5rem] @3xl:items-center";

/**
 * Every recorded call Call insights knows about, newest first, a page at a
 * time: who, when, the reading's status (with the reason in words when it
 * wasn't read), how many items it found and how many Jev's check hid. The
 * person's name opens the meeting.
 */
export function CallsTab() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1) ?? null;
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.callInsights.queries.calls,
    isAuthenticated
      ? {
          paginationOpts: { numItems: 25, cursor },
          ...(status === "all" ? {} : { status }),
        }
      : "skip",
  );
  const { data, reloading } = useKeptWhileLoading(
    result,
    `${status}:${cursor ?? ""}`,
  );
  const format = useLocalFormat();

  const filterLabel =
    CALL_STATUS_FILTERS.find((option) => option.value === status)?.label ??
    "All calls";

  return (
    <DetailCard
      title="Calls"
      meta={
        <Select
          value={status}
          onValueChange={(next) => {
            setStatus(next as StatusFilter);
            setCursors([null]);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Show calls by status"
            className="w-44"
          >
            <SelectValue>{filterLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {CALL_STATUS_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      }
    >
      <div className="@container">
        {data === undefined ? (
          <RowsSkeleton rows={8} rowHeight="h-14" label="Loading calls" />
        ) : data.page.length === 0 ? (
          status === "all" && cursors.length === 1 ? (
            <SectionEmpty title="No calls yet.">
              A call appears here once its Fathom recording is matched to a
              meeting.
            </SectionEmpty>
          ) : data.isDone ? (
            <SectionEmpty title="No more calls with this status." />
          ) : (
            <SectionEmpty title="No calls with this status on this page.">
              Next looks at older calls.
            </SectionEmpty>
          )
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
              <span className={cn(COLUMN_HEAD, "px-0")}>Status</span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Items found
              </span>
              <span className={cn(COLUMN_HEAD, "px-0 text-right")}>
                Hidden by Jev
              </span>
            </div>
            <ul aria-label="Recorded calls">
              {data.page.map((call) => {
                const read = call.latestStatus === "answered";
                const notRead =
                  call.latestStatus === "failed" ||
                  call.latestStatus === "skipped";
                return (
                  <li
                    key={`${call.recordingId}:${call.meetingId}`}
                    className={cn(
                      ROW_GRID,
                      "relative min-h-14 border-b py-2.5 last:border-b-0 hover:bg-muted/60",
                    )}
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/workspace/pipeline/meetings/${call.meetingId}`}
                        translate="no"
                        className="block truncate font-medium text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        {call.leadName}
                      </Link>
                      <p className="truncate text-[13px] text-muted-foreground">
                        <span translate="no">{call.closerName}</span> ·{" "}
                        <span className="font-condensed text-sm font-semibold tabular-nums">
                          {format(call.scheduledAt, "MMM d, h:mm a")}
                        </span>
                        {call.active
                          ? null
                          : " · not counted: moved or another prospect"}
                      </p>
                      <p className="text-[13px] text-muted-foreground @3xl:hidden">
                        {read
                          ? `${call.itemCount} items found · ${call.rejectedCount} hidden by Jev`
                          : null}
                      </p>
                    </div>
                    <div className="min-w-0 text-right @3xl:text-left">
                      <StatusWord tone={callStatusTone(call.latestStatus)}>
                        {callStatusWord(call.latestStatus)}
                      </StatusWord>
                      {notRead || call.latestStatus === "waiting" ? (
                        <p className="text-[13px] leading-snug text-muted-foreground">
                          {call.latestStatus === "waiting"
                            ? reasonWords("cap_reached")
                            : reasonWords(call.reasonCode)}
                        </p>
                      ) : null}
                    </div>
                    <p
                      className={cn(
                        FIGURE_15,
                        "hidden text-right @3xl:block",
                        !read && "text-muted-foreground",
                      )}
                    >
                      {read ? call.itemCount : "—"}
                    </p>
                    <p
                      className={cn(
                        FIGURE_15,
                        "hidden text-right @3xl:block",
                        (!read || call.rejectedCount === 0) &&
                          "text-muted-foreground",
                      )}
                    >
                      {read ? call.rejectedCount : "—"}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
      {data !== undefined && (cursors.length > 1 || !data.isDone) ? (
        <DetailCardFooter>
          <span className="text-[13px] font-normal">
            Newest first · 25 a page
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 1 || reloading}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={data.isDone || reloading}
              onClick={() =>
                setCursors((previous) => [...previous, data.continueCursor])
              }
            >
              Next
            </Button>
          </div>
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
