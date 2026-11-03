"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBusinessDay } from "@/hooks/use-business-day";
import { businessDateForInstant } from "@/lib/businessDay";
import { useBrowserTimezone } from "@/hooks/use-browser-timezone";
import { EndDayStatus } from "./end-day-status";
import type { BoardEntry } from "./todays-calls-board";

const EndMyDaySheet = dynamic(() =>
  import("./end-my-day-sheet").then((module) => module.EndMyDaySheet),
);

export function EndMyDayRow({
  meetings,
  now,
  visible,
}: {
  meetings: BoardEntry[] | undefined;
  now: number;
  visible: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timeZone = useBrowserTimezone();
  const { setting } = useBusinessDay();
  const summary = useQuery(
    api.closer.endOfDay.getDaySummary,
    visible && meetings !== undefined ? { now, timeZone } : "skip",
  );
  if (!visible || !meetings || !summary) return null;
  const remaining = meetings.filter(
    ({ meeting }) => meeting.status === "scheduled",
  ).length;
  const ready = remaining === 0;
  const latest = summary.latestReport;
  const recentlyEnded =
    latest &&
    businessDateForInstant(latest.periodEnd, setting) ===
      businessDateForInstant(now, setting);
  const since = new Intl.DateTimeFormat("en-US", {
    timeZone: summary.timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(summary.periodStart);
  return (
    <>
      <div
        className={cn(
          "flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-board-line px-[18px] py-2",
          ready && !recentlyEnded && "bg-primary text-primary-foreground",
        )}
      >
        <p className="text-[13px]" role="status">
          {recentlyEnded ? (
            <EndDayStatus report={latest} />
          ) : ready ? (
            <>
              <strong>Every call has a result.</strong> Your report covers{" "}
              {since} to now.
            </>
          ) : (
            `${remaining} ${remaining === 1 ? "call" : "calls"} still to go`
          )}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {recentlyEnded ? "End my day again" : "End my day"}
        </Button>
      </div>
      {open && (
        <EndMyDaySheet
          open={open}
          onOpenChange={setOpen}
          summary={summary}
          timeZone={timeZone}
        />
      )}
    </>
  );
}
