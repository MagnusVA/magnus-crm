"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  SectionEmpty,
  SectionError,
} from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { RowsSkeleton } from "@/app/workspace/reports/_components/report-ui";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 100;

type Loaded = {
  page: number;
  lines: Array<{
    speaker: string;
    email?: string;
    timestamp: string;
    text: string;
  }>;
  pageCount: number;
};

/**
 * The call's transcript, a hundred numbered lines a page, read through the
 * quality case's authorized reader. Clicking a line number hands it to the
 * form being edited (`onPickLine`); without one the numbers are plain text.
 * The whole panel is kept out of session replay and autocapture.
 */
export function GradingTranscript({
  caseId,
  lineCount,
  onPickLine,
  className,
}: {
  caseId: Id<"callInsightEvalCases">;
  lineCount: number;
  onPickLine?: (line: number) => void;
  className?: string;
}) {
  const readPage = useAction(api.callInsights.eval.cases.transcriptPage);
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedPage, setFailedPage] = useState<number | null>(null);

  useEffect(() => {
    if (lineCount === 0) return;
    let current = true;
    readPage({ caseId, page, pageSize: PAGE_SIZE }).then(
      (result) => {
        if (!current) return;
        setLoaded({ page, lines: result.lines, pageCount: result.pageCount });
        setFailedPage(null);
      },
      () => {
        if (current) setFailedPage(page);
      },
    );
    return () => {
      current = false;
    };
  }, [caseId, lineCount, page, readPage]);

  const pageCount =
    loaded?.pageCount ?? Math.max(1, Math.ceil(lineCount / PAGE_SIZE));
  const loading = failedPage !== page && loaded?.page !== page;
  const firstLine = (page - 1) * PAGE_SIZE + 1;

  return (
    <DetailCard
      title="Transcript"
      meta={lineCount ? `${lineCount} lines` : null}
      className={cn("ph-no-capture", className)}
    >
      {lineCount === 0 ? (
        <SectionEmpty title="The transcript is gone.">
          Fathom&apos;s copy expired or the recording moved, so this call
          can&apos;t be read here.
        </SectionEmpty>
      ) : failedPage === page ? (
        <SectionError what="this transcript page" />
      ) : loaded === null ? (
        <RowsSkeleton
          rows={10}
          rowHeight="h-12"
          label="Loading the transcript"
        />
      ) : loaded.lines.length === 0 ? (
        <SectionEmpty title="The transcript is gone." />
      ) : (
        <ol
          aria-label={`Transcript lines ${firstLine} to ${firstLine + loaded.lines.length - 1}`}
          aria-busy={loading || undefined}
          className={cn(
            "max-h-[70vh] overflow-y-auto transition-opacity duration-200 @5xl:max-h-[calc(100vh-14rem)]",
            loading && "opacity-60",
          )}
        >
          {loaded.lines.map((line, index) => {
            const number = (loaded.page - 1) * PAGE_SIZE + index + 1;
            return (
              <li
                key={number}
                className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2 border-b px-4 py-2 text-sm last:border-b-0"
              >
                {onPickLine ? (
                  <button
                    type="button"
                    onClick={() => onPickLine(number)}
                    aria-label={`Use line ${number}`}
                    className="-ml-1 inline-flex h-6 w-fit items-center rounded-sm px-1 font-condensed text-[13px] font-semibold text-muted-foreground tabular-nums underline decoration-foreground/30 underline-offset-[3px] outline-none hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    #{number}
                  </button>
                ) : (
                  <span className="pt-0.5 font-condensed text-[13px] font-semibold text-muted-foreground tabular-nums">
                    #{number}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-[13px] text-muted-foreground">
                    <span className="font-condensed font-semibold tabular-nums">
                      {line.timestamp}
                    </span>{" "}
                    · <span translate="no">{line.speaker}</span>
                  </p>
                  <p className="leading-snug break-words">{line.text}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {lineCount > 0 && pageCount > 1 ? (
        <DetailCardFooter>
          <span className="text-[13px] font-normal">
            Page{" "}
            <span className="font-condensed font-semibold tabular-nums">
              {page}
            </span>{" "}
            of{" "}
            <span className="font-condensed font-semibold tabular-nums">
              {pageCount}
            </span>
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount || loading}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
