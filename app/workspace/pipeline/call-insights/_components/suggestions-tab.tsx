"use client";

import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  detailLinkClass,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import {
  COLUMN_HEAD,
  FIGURE_15,
  ReportNote,
  RowsSkeleton,
} from "@/app/workspace/reports/_components/report-ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AGREEMENT_GROUPS,
  comparisonWords,
  noShowTierWords,
  percentOf,
  recordedKindWords,
  suggestionKindWords,
  suggestionTierWords,
} from "@/lib/callInsights/report-display";
import { cn } from "@/lib/utils";

const meetingHref = (meetingId: string) =>
  `/workspace/pipeline/meetings/${meetingId}`;

/**
 * Suggested results across the workspace: meetings still waiting for a result
 * that have one, results people saved that differ from it, and how Second
 * opinion's agreement splits by whether a suggestion was used. Confirming
 * happens on the meeting page, one at a time.
 */
export function SuggestionsTab({
  suggestions,
}: {
  suggestions: "off" | "hidden" | "on";
}) {
  const { isAuthenticated } = useConvexAuth();
  const lists = useQuery(
    api.callInsights.queries.suggestionQueue,
    isAuthenticated ? {} : "skip",
  );
  const format = useLocalFormat();

  return (
    <div className="flex flex-col gap-3.5 short:gap-3">
      {/* Suggested results come from the prospect's words: kept out of session replay. */}
      <DetailCard
        title="Waiting for a result"
        meta={
          lists
            ? `${lists.queue.length} ${lists.queue.length === 1 ? "meeting" : "meetings"}`
            : null
        }
        className="ph-no-capture"
      >
        {suggestions === "hidden" ? (
          <ReportNote>
            Suggestions are being checked in the background and aren&apos;t
            shown on meetings yet. Turn them on in Settings.
          </ReportNote>
        ) : null}
        {lists === undefined ? (
          <RowsSkeleton
            rows={4}
            rowHeight="h-14"
            label="Loading suggestions waiting for a result"
          />
        ) : lists.queue.length === 0 ? (
          <SectionEmpty title="No meeting is waiting with a suggestion.">
            {suggestions === "off"
              ? "Suggested results are off. Turn them on in Settings."
              : "Meetings appear here once a call is read and a result is suggested, until someone saves the result."}
          </SectionEmpty>
        ) : (
          <ul aria-label="Meetings waiting for a result" className="@container">
            {lists.queue.map((row) => (
              <li
                key={row.stateId}
                className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 last:border-b-0 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto]"
              >
                <div className="min-w-0">
                  <p translate="no" className="truncate font-medium">
                    {row.leadName}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    <span translate="no">{row.closerName}</span> ·{" "}
                    <span className="font-condensed text-sm font-semibold tabular-nums">
                      {format(row.scheduledAt, "MMM d, h:mm a")}
                    </span>
                  </p>
                </div>
                <div className="order-last col-span-2 min-w-0 @2xl:order-none @2xl:col-span-1">
                  <p className="truncate text-sm">
                    {suggestionKindWords(row.kind)}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {row.noShowTier && row.noShowTier !== "none"
                      ? `${noShowTierWords(row.noShowTier)} · ${suggestionTierWords(row.tier)}`
                      : suggestionTierWords(row.tier)}
                  </p>
                </div>
                <Link
                  href={meetingHref(row.meetingId)}
                  className={cn(detailLinkClass, "text-sm")}
                >
                  Open meeting
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DetailCard>

      <DetailCard
        title="Recorded result differs"
        meta={
          lists
            ? `${lists.differs.length} ${lists.differs.length === 1 ? "meeting" : "meetings"}`
            : null
        }
        className="ph-no-capture"
      >
        {lists === undefined ? (
          <RowsSkeleton
            rows={3}
            rowHeight="h-14"
            label="Loading results that differ"
          />
        ) : lists.differs.length === 0 ? (
          <SectionEmpty title="No saved result differs from its suggestion." />
        ) : (
          <ul
            aria-label="Results that differ from the suggestion"
            className="@container"
          >
            {lists.differs.map((row) => (
              <li
                key={row.meetingId}
                className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 last:border-b-0 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_auto]"
              >
                <div className="min-w-0">
                  <p translate="no" className="truncate font-medium">
                    {row.leadName}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {comparisonWords(row.comparison)}
                    {row.usedAt ? " · saved from the suggestion" : null}
                  </p>
                </div>
                <p className="order-last col-span-2 min-w-0 text-sm @2xl:order-none @2xl:col-span-1">
                  <span className="text-muted-foreground">Suggested </span>
                  {suggestionKindWords(row.suggestedKind)}
                  <span className="text-muted-foreground"> · saved </span>
                  {recordedKindWords(row.recordedKind)}
                </p>
                <Link
                  href={meetingHref(row.meetingId)}
                  className={cn(detailLinkClass, "text-sm")}
                >
                  Open meeting
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DetailCard>

      <AgreementCard />
    </div>
  );
}

/** Second opinion's agreement this month, split by how the suggestion was used. */
function AgreementCard() {
  const { isAuthenticated } = useConvexAuth();
  const split = useQuery(
    api.callInsights.queries.agreementSplit,
    isAuthenticated ? {} : "skip",
  );
  const total = split
    ? AGREEMENT_GROUPS.reduce((sum, group) => sum + split[group.key].total, 0)
    : 0;

  return (
    <DetailCard
      title="Second opinion agreement by suggestion use"
      meta="This month"
    >
      <ReportNote>
        Results saved from a suggestion aren&apos;t independent of it, so the
        first row is the honest figure.
      </ReportNote>
      {split === undefined ? (
        <RowsSkeleton
          rows={4}
          rowHeight="h-10"
          label="Loading second opinion agreement"
        />
      ) : split === null || total === 0 ? (
        <SectionEmpty title="No second opinions this month." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={cn(COLUMN_HEAD, "pl-4")}>Group</TableHead>
              <TableHead className={cn(COLUMN_HEAD, "text-right")}>
                Checks
              </TableHead>
              <TableHead className={cn(COLUMN_HEAD, "text-right")}>
                Agrees
              </TableHead>
              <TableHead className={cn(COLUMN_HEAD, "text-right")}>
                Disagrees
              </TableHead>
              <TableHead className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                Unsure
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {AGREEMENT_GROUPS.map((group) => {
              const row = split[group.key];
              return (
                <TableRow key={group.key}>
                  <TableCell className="pl-4">{group.label}</TableCell>
                  <TableCell className={cn(FIGURE_15, "text-right")}>
                    {row.total}
                  </TableCell>
                  <CountCell count={row.agrees} total={row.total} />
                  <CountCell count={row.disagrees} total={row.total} />
                  <CountCell count={row.unsure} total={row.total} last />
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </DetailCard>
  );
}

function CountCell({
  count,
  total,
  last,
}: {
  count: number;
  total: number;
  last?: boolean;
}) {
  return (
    <TableCell className={cn("text-right", last && "pr-4")}>
      <span className={FIGURE_15}>{count}</span>
      <span className="ml-1.5 text-[13px] text-muted-foreground">
        {percentOf(count, total)}
      </span>
    </TableCell>
  );
}
