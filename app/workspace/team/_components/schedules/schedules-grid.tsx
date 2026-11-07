"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useMemberCardHref } from "../member-card/member-card-host";
import { formatBusinessDate, formatHours, SHORT_DAY, WEEKDAYS, weekTotal, type Weekday, type WeekHours } from "../schedule-editor";
import { Code, HelpTip, Initials, LABEL } from "../team-ui";
import { LONG_DAY, ROLE_WORD, type ScheduleGroup, type ScheduleRow } from "./schedule-model";

// The week grid: a name column, seven day columns, then the week's total.
// Every row, group head and footer uses the same columns.
const GRID =
  "grid grid-cols-[minmax(148px,1.5fr)_repeat(7,minmax(34px,1fr))_68px] @3xl/grid:grid-cols-[minmax(220px,1.7fr)_repeat(7,minmax(44px,1fr))_88px]";

export function SchedulesGrid({
  groups,
  showRole,
  totalLabel,
}: {
  groups: ScheduleGroup[];
  /** Under All, each row names its role. */
  showRole: boolean;
  /** The last row's label, when there is more than one group: "Everyone", "Lead gen". */
  totalLabel: string;
}) {
  const allRows = groups.flatMap((candidate) => candidate.rows);
  const total = sumWeeks(groups.map((candidate) => candidate.byDay));
  return (
    <div className="@container/grid overflow-x-auto">
      <div role="table" aria-label="Weekly schedules" className="min-w-[520px]">
        <div role="rowgroup">
          <div role="row" className={cn(GRID, "h-8 items-center border-b border-border")}>
            <span role="columnheader" className={cn(LABEL, "pl-4")}>
              <HelpTip tip="One row per role: someone who is a lead generator and a DM closer has a week for each. Click a row to change that week.">
                Team member
              </HelpTip>
            </span>
            {WEEKDAYS.map((day) => (
              <span key={day} role="columnheader" className={cn(LABEL, "text-center")}>
                {SHORT_DAY[day]}
              </span>
            ))}
            <span role="columnheader" className={cn(LABEL, "pr-4 text-right")}>
              Week
            </span>
          </div>
        </div>
        {groups.map((candidate) => (
          <GroupRows key={candidate.key} group={candidate} showRole={showRole} />
        ))}
        {groups.length > 1 ? (
          <div role="rowgroup">
            <div role="row" className={cn(GRID, "min-h-11 items-center bg-muted/60")}>
              <span role="rowheader" className="pl-4 text-[13px] font-semibold">
                {totalLabel} · {allRows.length} {allRows.length === 1 ? "week" : "weeks"}
              </span>
              {WEEKDAYS.map((day) => (
                <span key={day} role="cell" className="text-center font-condensed text-[15px] font-bold tabular-nums">
                  {total[day] > 0 ? formatHours(total[day]) : "–"}
                </span>
              ))}
              <span role="cell" className="pr-4 text-right font-condensed text-[15px] font-bold tabular-nums">
                {formatHours(weekTotal(total))}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function sumWeeks(weeks: WeekHours[]) {
  const total = Object.fromEntries(WEEKDAYS.map((day) => [day, 0])) as WeekHours;
  for (const week of weeks) for (const day of WEEKDAYS) total[day] += week[day];
  return total;
}

function GroupRows({ group, showRole }: { group: ScheduleGroup; showRole: boolean }) {
  return (
    <div role="rowgroup" aria-label={group.title}>
      <div role="row" className="flex min-h-9 items-center border-b border-border bg-muted/40 px-4">
        <span role="rowheader" className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn(LABEL, "text-foreground")}>
            {showRole && group.role !== "slack" ? `${group.role === "lead_gen" ? "Lead gen" : "DM closers"} · ` : null}
            {group.title}
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            {group.rows.length} {group.rows.length === 1 ? "week" : "weeks"}
            {group.teamArchived ? " · archived team" : null}
            {group.kind === "slack" ? " · no team; the qualified-leads goal is for the whole workspace" : null}
          </span>
          {group.teamId ? (
            <Link
              href={`/workspace/team/teams/${group.teamId}`}
              aria-label={`${group.title}’s team page`}
              className="ml-auto shrink-0 self-center rounded-sm text-[12.5px] text-muted-foreground underline decoration-current/40 underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Team page
            </Link>
          ) : null}
        </span>
      </div>
      {group.rows.map((row) => (
        <WeekRow key={row.id} row={row} showRole={showRole} />
      ))}
      <GroupFooter group={group} />
    </div>
  );
}

function WeekRow({ row, showRole }: { row: ScheduleRow; showRole: boolean }) {
  const cardHref = useMemberCardHref();
  const total = weekTotal(row.week);
  const label = `${row.member.name}, ${ROLE_WORD[row.role]}${row.utmMedium ? ` (${row.utmMedium})` : ""}: ${
    row.scheduled ? `${formatHours(total)} h a week` : "no schedule"
  }. Open to change the week.`;
  return (
    <div
      role="row"
      className={cn(
        GRID,
        "group/row relative min-h-11 items-center border-b border-border hover:bg-muted/50 has-[a:focus-visible]:bg-muted/50",
        !row.active && "text-muted-foreground",
      )}
    >
      <span role="rowheader" className="flex min-w-0 items-center gap-2.5 py-1.5 pl-4">
        <span className="hidden @3xl/grid:inline-flex">
          <Initials name={row.member.name} size="sm" />
        </span>
        <span className="flex min-w-0 flex-col">
          <Link
            href={cardHref(row.member.key, row.role)}
            aria-label={label}
            className="truncate rounded-sm text-[14px] font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {row.member.name}
          </Link>
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-muted-foreground">
            {showRole ? <RoleChip role={row.role} /> : null}
            {!row.active ? (
              <span className="shrink-0 whitespace-nowrap">{row.role === "slack" ? "Deleted in Slack" : "Inactive"}</span>
            ) : null}
            {row.active && !row.scheduled ? (
              <span className="shrink-0 font-medium whitespace-nowrap text-warning-ink">No schedule</span>
            ) : null}
            {/* Under All the chip has little room: name the link only where it tells two rows apart. */}
            {row.utmMedium && (!showRole || row.sameRole > 1) ? (
              <Code className="min-w-0 truncate px-1 py-0 text-[11.5px]">{row.utmMedium}</Code>
            ) : null}
          </span>
        </span>
      </span>
      {WEEKDAYS.map((day) => {
        const hours = row.week?.[day] ?? 0;
        return (
          <span key={day} role="cell" className="flex justify-center px-[3px]">
            {hours > 0 ? (
              <span className="flex h-[26px] w-full max-w-[96px] items-center justify-center rounded-[5px] bg-muted font-condensed text-[15px] font-semibold tabular-nums">
                {formatHours(hours)}
              </span>
            ) : (
              <span className="font-condensed text-[15px] text-muted-foreground/70" aria-label="0 h">
                –
              </span>
            )}
          </span>
        );
      })}
      <span role="cell" className="flex flex-col items-end pr-4 leading-tight">
        <span className="font-condensed text-[15px] font-semibold tabular-nums">
          {row.scheduled ? formatHours(total) : <span className="text-muted-foreground">–</span>}
        </span>
        {row.weekChangedOn ? (
          <span className="text-[11.5px] whitespace-nowrap text-muted-foreground">
            Since {formatBusinessDate(row.weekChangedOn)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function RoleChip({ role }: { role: ScheduleRow["role"] }) {
  return (
    <span className="shrink-0 rounded-[4px] bg-muted px-1.5 py-px font-condensed text-[11px] font-semibold tracking-[0.08em] text-foreground/80 uppercase">
      {ROLE_WORD[role]}
    </span>
  );
}

/** What a day nobody in the group works means, in the group's own terms. */
function gapTip(group: ScheduleGroup, day: Weekday) {
  const days = LONG_DAY[day];
  switch (group.kind) {
    case "dm_team":
      return group.teamArchived
        ? `Nobody on ${group.title} works ${days}. The team is archived, so it has no goal.`
        : `Nobody on ${group.title} works ${days}, so its booked-calls goal skips ${days}.`;
    case "slack":
      return `No Slack qualifier works ${days}, so the qualified-leads goal skips ${days}.`;
    case "lead_gen_team":
      return `Nobody on ${group.title}’s lead gen works ${days}. Lead gen has no goal, so nothing skips it.`;
    case "lead_gen_none":
      return `No lead generator without a team works ${days}. Lead gen has no goal, so nothing skips it.`;
  }
}

function noHoursTip(group: ScheduleGroup) {
  switch (group.kind) {
    case "dm_team":
      return `Nobody on ${group.title} has hours yet, so its booked-calls goal counts every day.`;
    case "slack":
      return "No Slack qualifier has hours yet, so the qualified-leads goal counts every day.";
    default:
      return "Nobody here has hours yet.";
  }
}

function GroupFooter({ group }: { group: ScheduleGroup }) {
  const gaps = new Set(group.gaps);
  return (
    <div role="row" className={cn(GRID, "min-h-9 items-center border-b border-border bg-muted/40")}>
      <span role="rowheader" className="pl-4 text-[12.5px] text-muted-foreground">
        {group.anyHours ? (
          <HelpTip tip="Each weekday’s hours over this group’s active weeks. A day at 0 h, hatched, is a day nobody here works.">
            Hours a day
          </HelpTip>
        ) : (
          <HelpTip tip={noHoursTip(group)} className="text-warning-ink">
            No hours yet
          </HelpTip>
        )}
      </span>
      {WEEKDAYS.map((day) =>
        gaps.has(day) ? (
          <span
            key={day}
            role="cell"
            className="flex h-full min-h-9 items-center justify-center bg-[repeating-linear-gradient(135deg,var(--color-warning-surface)_0_6px,transparent_6px_12px)] text-warning-ink"
          >
            <HelpTip tip={gapTip(group, day)} className="font-condensed text-[14px] font-semibold tabular-nums">
              0 h
            </HelpTip>
          </span>
        ) : (
          <span key={day} role="cell" className="text-center font-condensed text-[14px] font-semibold tabular-nums">
            {group.byDay[day] > 0 ? formatHours(group.byDay[day]) : <span className="text-muted-foreground/70">–</span>}
          </span>
        ),
      )}
      <span role="cell" className="pr-4 text-right font-condensed text-[14px] font-semibold tabular-nums">
        {formatHours(weekTotal(group.byDay))}
      </span>
    </div>
  );
}
