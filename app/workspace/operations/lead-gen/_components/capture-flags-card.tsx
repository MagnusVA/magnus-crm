"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinessDay } from "@/hooks/use-business-day";
import { dayAndTime } from "@/app/workspace/lead-gen/_components/setter-ui";

const CaptureFlagDialog = dynamic(() =>
  import("@/app/workspace/lead-gen/_components/capture-flag-dialog").then(
    (mod) => mod.CaptureFlagDialog,
  ),
);
const VoidSubmissionDialog = dynamic(() =>
  import("./void-submission-dialog").then((mod) => mod.VoidSubmissionDialog),
);
const PAGE_SIZE = 25;

/** Its own live queue: no report date or source filters. */
export function CaptureFlagsCard() {
  const { setting } = useBusinessDay("lead-gen");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const page = useQuery(api.leadGen.captureFlags.listOpen, {
    paginationOpts: { cursor: cursors[pageIndex], numItems: PAGE_SIZE },
  });
  const results = page?.page;
  const hasPrevious = pageIndex > 0;
  const hasNext = page !== undefined && !page.isDone;
  function next() {
    if (!page || page.isDone) return;
    setCursors([...cursors.slice(0, pageIndex + 1), page.continueCursor]);
    setPageIndex(pageIndex + 1);
  }
  return (
    <DetailCard
      title="Flagged captures"
      meta="All dates · oldest first"
      className="@container/flags"
    >
      {results === undefined ? (
        <div
          role="status"
          aria-label="Loading flagged captures"
          className="flex flex-col gap-3 px-4 py-3"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      ) : results.length === 0 ? (
        <SectionEmpty
          title={
            pageIndex === 0
              ? "No captures waiting for review."
              : "No more captures on this page."
          }
        />
      ) : (
        <ul aria-label="Captures waiting for review">
          {results.map((row) => {
            const label = row.handle ? `@${row.handle}` : "this person";
            return (
              <li
                key={row.flagId}
                className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0 @xl/flags:flex-row @xl/flags:items-start @xl/flags:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words" translate="no">
                    {label}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    {row.worker ?? "Specialist"} ·{" "}
                    <time
                      dateTime={new Date(row.createdAt).toISOString()}
                      className="font-condensed tabular-nums"
                    >
                      {dayAndTime(row.createdAt, setting.timeZone)}
                    </time>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                    {row.reason}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 self-end @xl/flags:self-start">
                  <VoidSubmissionDialog
                    submissionId={row.submissionId}
                    prospectLabel={label}
                  />
                  <CaptureFlagDialog
                    kind="dismiss"
                    flagId={row.flagId}
                    prospectLabel={label}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasPrevious || hasNext ? (
        <DetailCardFooter>
          <span className="text-[13px]" aria-live="polite">
            Page {pageIndex + 1}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={!hasPrevious || !page}
              onClick={() => {
                if (hasPrevious && page) setPageIndex(pageIndex - 1);
              }}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={!hasNext}
              onClick={next}
            >
              Next
            </Button>
          </div>
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
