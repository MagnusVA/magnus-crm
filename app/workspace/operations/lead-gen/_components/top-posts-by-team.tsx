"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { DetailCard, DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { ScrollMoreHint } from "@/app/workspace/closer/_components/scroll-more-hint";
import { useExpandInPlace } from "@/app/workspace/closer/_components/use-expand-in-place";
import { TopPostsList } from "@/app/workspace/_components/top-origins-overview-section";
import { Skeleton } from "@/components/ui/skeleton";
import type { LeadDashboardOriginTeam } from "@/lib/operations-reports/lead-dashboard";
import { cn } from "@/lib/utils";
import { formatCount, plural, reloadingClass } from "./lead-gen-format";

// Which posts pulled people in, per team (DESIGN.md, The Top Posts Row): one
// team at a time behind tabs, five posts, then the team's top ten in place.

const COLLAPSED_ROWS = 5;

function teamKey(group: LeadDashboardOriginTeam) {
  return group.teamId ?? "unassigned";
}

function TeamTabs({
  groups,
  selected,
  onSelect,
  panelId,
}: {
  groups: LeadDashboardOriginTeam[];
  selected: string;
  onSelect: (key: string) => void;
  panelId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const current = Math.max(0, groups.findIndex((group) => teamKey(group) === selected));

  const select = (index: number) => {
    const next = (index + groups.length) % groups.length;
    onSelect(teamKey(groups[next]));
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") select(current + 1);
    else if (event.key === "ArrowLeft") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(groups.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Team"
      onKeyDown={onKeyDown}
      className="flex min-w-0 gap-[18px] overflow-x-auto border-b px-4 [scrollbar-width:none]"
    >
      {groups.map((group, index) => {
        const active = index === current;
        return (
          <button
            key={teamKey(group)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(teamKey(group))}
            className={cn(
              "h-10 shrink-0 border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {group.teamName}
          </button>
        );
      })}
    </div>
  );
}

function TeamPosts({ group, todayBusinessDate }: { group: LeadDashboardOriginTeam; todayBusinessDate: string | undefined }) {
  const canExpand = group.origins.length > COLLAPSED_ROWS;
  const expand = useExpandInPlace<HTMLDivElement>(canExpand);
  const rows = expand.expanded ? group.origins : group.origins.slice(0, COLLAPSED_ROWS);
  return (
    <>
      <div className="relative">
        <div {...expand.listProps}>
          <TopPostsList
            rows={rows}
            todayBusinessDate={todayBusinessDate}
            label={`${group.teamName} top posts and reels by submissions`}
          />
        </div>
        <ScrollMoreHint {...expand.hintProps} />
      </div>
      <DetailCardFooter>
        <span className="text-[13px] font-normal">
          <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
            {formatCount(group.totalSubmissions)}
          </span>{" "}
          {group.totalSubmissions === 1 ? "submission" : "submissions"} from posts and reels
        </span>
        {canExpand ? (
          <button
            type="button"
            onClick={expand.toggle}
            className="inline-flex min-h-6 items-center rounded-sm font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expand.expanded ? `Show top ${COLLAPSED_ROWS}` : `Show top ${group.origins.length}`}
          </button>
        ) : null}
      </DetailCardFooter>
    </>
  );
}

export function PostsSkeleton() {
  return (
    <div role="status" aria-label="Loading top posts and reels" className="flex flex-col">
      {Array.from({ length: COLLAPSED_ROWS }, (_, index) => (
        <div key={index} className="flex h-[61px] items-center gap-3 border-b px-4 last:border-b-0">
          <Skeleton className="size-11 rounded-[7px]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-3 w-28 max-w-full" />
          </div>
          <Skeleton className="h-5 w-8" />
        </div>
      ))}
    </div>
  );
}

export function TopPostsByTeam({
  groups,
  rangePhrase,
  reloading,
  todayBusinessDate,
}: {
  groups: LeadDashboardOriginTeam[] | undefined;
  rangePhrase: string;
  reloading: boolean;
  /** Post dates drop the year when it is this business year. */
  todayBusinessDate?: string;
}) {
  const panelId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const ranked = (groups ?? []).filter((group) => group.origins.length > 0);
  // The chosen team, or the busiest one when it is gone from this range.
  const active = ranked.find((group) => teamKey(group) === chosen) ?? ranked[0];
  const single = ranked.length === 1;

  return (
    <DetailCard
      title="Top posts & reels"
      meta={single ? `${active.teamName} · by submissions` : ranked.length > 1 ? `${plural(ranked.length, "team")} · by submissions` : "By submissions"}
      className="min-w-0"
    >
      <div aria-busy={reloading} className={reloadingClass(reloading)}>
        {groups === undefined ? (
          <PostsSkeleton />
        ) : active === undefined ? (
          <SectionEmpty title={`No submissions came from a post or reel ${rangePhrase}.`} />
        ) : (
          <>
            {single ? null : (
              <TeamTabs groups={ranked} selected={teamKey(active)} onSelect={setChosen} panelId={panelId} />
            )}
            <div id={panelId} role={single ? undefined : "tabpanel"} aria-label={single ? undefined : active.teamName}>
              {/* A new team starts collapsed. */}
              <TeamPosts key={teamKey(active)} group={active} todayBusinessDate={todayBusinessDate} />
            </div>
          </>
        )}
      </div>
    </DetailCard>
  );
}
