"use client";

import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import type { QualificationOpenerViewModel } from "@/lib/operations-reports/qualification-dashboard";
import { ScheduleHoursLink, teamHref } from "../../_components/team-links";
import { eventTime, formatPerHour } from "./qualifications-format";

// The desk's left pane: every setter by what they qualified, "All setters"
// first. A row is a filter for the submissions pane beside it.

const ROW =
  "relative flex w-full flex-col gap-1.5 border-b px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-muted/80 aria-pressed:shadow-[inset_3px_0_0_var(--color-foreground)]";

/**
 * A setter's row: the filter button, then their hours as a link to their
 * week in Team. A link can't sit inside a button, so the item carries the
 * rule, the hover and the pressed fill for both.
 */
const SETTER_ITEM =
  "border-b transition-colors hover:bg-muted/60 has-[>button[aria-pressed=true]]:bg-muted/80 has-[>button[aria-pressed=true]]:shadow-[inset_3px_0_0_var(--color-foreground)]";
const SETTER_BUTTON =
  "relative flex w-full flex-col gap-1.5 px-4 pt-2.5 pb-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function RateLine({ setter }: { setter: QualificationOpenerViewModel }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  return (
    <span className="truncate text-[13px] text-muted-foreground">
      {setter.qualifiedPerHour === null ? null : (
        <>
          <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
            {formatPerHour(setter.qualifiedPerHour)}
          </span>
          /h
        </>
      )}
      {setter.lastEventAt !== null
        ? `${setter.qualifiedPerHour === null ? "" : " · "}${eventTime(setter.lastEventAt, now, setting)}`
        : null}
    </span>
  );
}

export function SettersPane({
  setters,
  failed,
  total,
  selected,
  onSelect,
}: {
  setters: QualificationOpenerViewModel[] | undefined;
  /** The report failed with nothing kept; the notice above the desk says why. */
  failed: boolean;
  /** The team's count, the band's figure; it also holds leads no setter is named on. */
  total: number | undefined;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  if (setters === undefined) {
    return failed ? (
      <p className="px-4 py-4 text-sm text-muted-foreground">Setters can&apos;t show until the report loads.</p>
    ) : (
      <SettersSkeleton />
    );
  }

  // A pressed setter keeps its row in a range where it has no leads.
  const active = setters.filter((setter) => setter.qualified > 0 || setter.key === selected);
  const quiet = setters.filter((setter) => setter.qualified === 0 && setter.key !== selected);
  const teamTotal = total ?? active.reduce((sum, setter) => sum + setter.qualified, 0);
  const top = Math.max(1, ...active.map((setter) => setter.qualified));

  return (
    <ul aria-label="Setters" className="flex flex-col">
      <li>
        <button type="button" aria-pressed={selected === null} onClick={() => onSelect(null)} className={ROW}>
          <span className="flex items-center gap-2.5">
            <span className="flex-1 font-semibold">All setters</span>
            <span className="font-condensed text-xl leading-none font-semibold tabular-nums">
              {formatWholeNumber(teamTotal)}
              <span className="sr-only"> qualified</span>
            </span>
          </span>
          <span className="text-[13px] text-muted-foreground">
            {active.every((setter) => setter.qualified === 0)
              ? "No setter qualified a lead"
              : `${formatWholeNumber(active.filter((setter) => setter.qualified > 0).length)} of ${formatWholeNumber(setters.length)} ${setters.length === 1 ? "setter" : "setters"} qualified a lead`}
          </span>
        </button>
      </li>
      {active.map((setter) => (
        <li key={setter.key} className={SETTER_ITEM}>
          <button
            type="button"
            aria-pressed={selected === setter.key}
            onClick={() => onSelect(selected === setter.key ? null : setter.key)}
            className={SETTER_BUTTON}
          >
            <span className="flex items-center gap-2.5">
              <MemberAvatar identity={setter.avatar} size="sm" />
              <span className="min-w-0 flex-1 truncate font-semibold">{setter.label}</span>
              <span className="font-condensed text-xl leading-none font-semibold tabular-nums">
                {formatWholeNumber(setter.qualified)}
                <span className="sr-only"> qualified</span>
              </span>
            </span>
            <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 pl-[34px]">
              <span className="h-2 overflow-hidden rounded-[2px]" aria-hidden="true">
                <span
                  className={cn(
                    "block h-full rounded-[2px] transition-colors duration-200 motion-reduce:transition-none",
                    selected === setter.key ? "bg-foreground/80" : "bg-foreground/25",
                  )}
                  style={{ width: `${(setter.qualified / top) * 100}%` }}
                />
              </span>
              <RateLine setter={setter} />
            </span>
          </button>
          <p className="truncate pr-4 pb-2.5 pl-[50px] text-[13px] text-muted-foreground">
            <ScheduleHoursLink
              href={teamHref.slackUser(setter.key)}
              hours={setter.scheduledHours}
              name={setter.label}
            />
          </p>
        </li>
      ))}
      {quiet.length > 0 ? (
        <li className="px-4 py-2.5 text-[13px] text-muted-foreground">
          No leads from{" "}
          <span className="font-medium text-foreground">{quiet.map((setter) => setter.label).join(", ")}</span>
        </li>
      ) : null}
    </ul>
  );
}

function SettersSkeleton() {
  return (
    <div role="status" aria-label="Loading setters" className="flex flex-col">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex h-[62px] flex-col justify-center gap-2 border-b px-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="ml-auto h-5 w-6" />
          </div>
          <Skeleton className="ml-[34px] h-2 w-1/2" />
        </div>
      ))}
    </div>
  );
}
