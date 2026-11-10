"use client";

import { useReportViewed } from "../../_components/use-report-page";
import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FreshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import { currentAnswers } from "@/lib/reporting/export";
import { ReportExportMenu, useRowsExport } from "../../_components/report-export-menu";
import { BAND_SELECT, REPORT_PAGE, ReportBand } from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { LogFeed } from "./log-feed";
import { ENTITY_TYPES, buildLogDocument, type LogEntityType } from "./log-shape";
import { useTeamMembers } from "./use-team-members";

// The Log (docs/reviews/reports-overhaul.html §12): the audit trail for a
// range, newest first, filtered by member and record type. It reads Convex
// live and pages, so it has no ClickHouse source.

const PAGE_SIZE = 50;
const ALL = "__all__";
const LIVE: FreshnessSummary = { kind: "line", label: "Live", live: true, delayedSince: null };

export function LogPageClient() {
  usePageTitle("Log");
  useReportViewed("log");
  const range = useReportRange();
  const team = useTeamMembers();
  const [teamMemberId, setTeamMemberId] = useState<Id<"teamMembers"> | undefined>();
  const [entityType, setEntityType] = useState<LogEntityType | undefined>();
  // Every event in the range with these filters, not just the loaded rows.
  const eventsExport = useRowsExport("events", "log", range.dates.startBusinessDate, range.dates.endBusinessDateInclusive, {
    ...(teamMemberId ? { teamMemberId } : {}),
    ...(entityType ? { entityType } : {}),
  });

  const feed = usePaginatedQuery(
    api.reports.log.listLog,
    range.loaded
      ? {
          ...range.window,
          ...(teamMemberId ? { teamMemberId } : {}),
          ...(entityType ? { entityType } : {}),
        }
      : "skip",
    { initialNumItems: PAGE_SIZE },
  );
  const filterKey = `${range.phrase}|${range.window.startDate}|${teamMemberId ?? ""}|${entityType ?? ""}`;
  const firstPage = feed.status === "LoadingFirstPage" ? undefined : feed.results;
  // New filters keep the last rows on screen, dimmed, until the first page lands.
  const kept = useKeptWhileLoading(firstPage, filterKey);
  const entries = kept.data;
  const filtered = teamMemberId !== undefined || entityType !== undefined;
  const memberName = teamMemberId ? team?.members.find((member) => member.teamMemberId === teamMemberId)?.name : undefined;
  const entityLabel = entityType ? ENTITY_TYPES.find((type) => type.value === entityType)?.label : undefined;
  const filterWords = [memberName ? `Member: ${memberName}` : null, entityLabel ? `Records: ${entityLabel}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Log"
        range={range.words}
        freshness={entries ? LIVE : null}
        dayLine={range.dayLine}
        actions={
          <>
            <ReportRangePicker range={range} />
            <ReportExportMenu
              page="log"
              startDate={range.dates.startBusinessDate}
              endDate={range.dates.endBusinessDateInclusive}
              memberName={memberName}
              extra={[eventsExport]}
              buildDocument={() => {
                const current = currentAnswers({ entries: kept });
                return current
                  ? buildLogDocument(current.entries, {
                      words: range.words,
                      dayLine: range.dayLine,
                      filters: filterWords || "Every member and record",
                      generatedAt: Date.now(),
                      complete: feed.status === "Exhausted",
                    })
                  : null;
              }}
            />
          </>
        }
        filters={
          <>
            <Select
              value={teamMemberId ?? ALL}
              onValueChange={(next) => setTeamMemberId(next === ALL ? undefined : (next as Id<"teamMembers">))}
              disabled={team === undefined}
            >
              <SelectTrigger aria-label="Member" className={cn(BAND_SELECT, "w-[200px] max-w-full [&>span]:truncate")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All members</SelectItem>
                {team?.members.map((member) => (
                  <SelectItem key={member.teamMemberId} value={member.teamMemberId}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={entityType ?? ALL}
              onValueChange={(next) => setEntityType(next === ALL ? undefined : (next as LogEntityType))}
            >
              <SelectTrigger aria-label="Record type" className={cn(BAND_SELECT, "w-[168px] max-w-full")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All records</SelectItem>
                {ENTITY_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <ReportRangeMessage range={range} />

      <LogFeed
        entries={entries}
        hasMore={feed.status === "CanLoadMore" || feed.status === "LoadingMore"}
        loadingMore={feed.status === "LoadingMore"}
        onLoadMore={() => feed.loadMore(PAGE_SIZE)}
        pageSize={PAGE_SIZE}
        reloading={kept.reloading}
        oneDay={range.dates.startBusinessDate === range.dates.endBusinessDateInclusive}
        phrase={range.phrase}
        onClearFilters={
          filtered
            ? () => {
                setTeamMemberId(undefined);
                setEntityType(undefined);
              }
            : undefined
        }
      />
    </div>
  );
}
