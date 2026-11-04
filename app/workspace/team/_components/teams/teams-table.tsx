"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { PencilIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { ArchiveButton } from "./archive-team-button";
import { formatHours } from "../schedule-editor";
import { ActiveWord, CardHead, CARD, FIGURE, HelpTip, Initials, LABEL } from "../team-ui";
import { membersLine, workerName, type TeamDoc, type TeamsDirectory } from "./teams-data";

// Mirrors MAX_BOOKING_DAILY_QUOTA in convex/attribution/teams.ts.
const MAX_DAILY_GOAL = 5000;

/** h-11's teams grid, folding columns away as the page narrows. */
const GRID =
  "grid items-center gap-3.5 px-4 grid-cols-[minmax(0,1fr)_64px_minmax(92px,auto)] @2xl:grid-cols-[minmax(170px,1fr)_minmax(0,1.4fr)_80px_minmax(150px,0.7fr)_150px]";

export function TeamsTable({ directory }: { directory: TeamsDirectory }) {
  const teams = [...directory.teams].sort((a, b) => {
    const left = directory.statsFor(a._id);
    const right = directory.statsFor(b._id);
    return (
      Number(b.isActive) - Number(a.isActive) ||
      right.activeLeadGen + right.activeDm - (left.activeLeadGen + left.activeDm) ||
      a.displayName.localeCompare(b.displayName)
    );
  });
  const noTeam = directory.noTeam;

  return (
    <section className={CARD} aria-labelledby="teams-title">
      <CardHead
        title={<span id="teams-title">Teams</span>}
        meta="Click a team to see who’s on it and set their weeks"
      />
      <p className="border-b border-border bg-muted/40 px-4 py-2 text-[13px] text-muted-foreground">
        Teams used to be made in two places, Lead Gen settings and Booking setup › DM teams. It was always one list;
        now it has one page.
      </p>
      <div className={cn(GRID, "relative z-10 min-h-[34px] border-b border-border pt-3 pb-2")}>
        <span className={LABEL}>
          <HelpTip tip="Its name, and the utm_source its DM closers' links carry. Bookings with it credit the team.">
            Team
          </HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @2xl:block")}>
          <HelpTip tip="Active lead generators and DM closers on the team. Slack qualifiers have no team.">
            Members
          </HelpTip>
        </span>
        <span className={cn(LABEL, "text-right")}>
          <HelpTip tip="The weeks in force today of the team's active lead generators and DM closers, added up. Set a week from a DM closer's or lead generator's card.">
            Hours a week
          </HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @2xl:block")}>
          <HelpTip tip="Booked calls the team should make each business day. Booked Calls draws the team's goal ring from it. Click a goal to change it.">
            Booked goal
          </HelpTip>
        </span>
        <span className={LABEL}>
          <HelpTip tip="Active teams appear on reports and in the link portal, and get credit for bookings. Archived teams drop off them; their history stays.">
            Status
          </HelpTip>
        </span>
      </div>
      {teams.length === 0 ? (
        <p className="border-b border-border px-4 py-5 text-[14px] text-muted-foreground">
          No teams yet. A team is one utm_source; its DM closers’ links carry it, and its lead generators count for it.
          Add one with New team.
        </p>
      ) : (
        <ul>
          {teams.map((team) => (
            <TeamRow key={team._id} team={team} directory={directory} />
          ))}
        </ul>
      )}
      <Link
        href="/workspace/team?role=lead_gen"
        className={cn(
          GRID,
          "min-h-14 border-t border-border py-[9px] outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        <span className="min-w-0">
          <span className="block text-[14px] text-muted-foreground">No team</span>
          <small className="block text-[12.5px] text-muted-foreground">Lead Gen lists them last</small>
        </span>
        <span className="col-span-2 min-w-0 text-[13px] text-muted-foreground @2xl:col-span-4">
          {noTeam.length === 0
            ? "Every active lead generator is on a team."
            : `${noTeam.length} active lead ${noTeam.length === 1 ? "generator" : "generators"}: ${noTeam.map(workerName).join(", ")}`}
        </span>
      </Link>
    </section>
  );
}

function TeamRow({ team, directory }: { team: TeamDoc; directory: TeamsDirectory }) {
  const stats = directory.statsFor(team._id);
  const active = [
    ...stats.leadGen.filter((worker) => worker.isActive).map((worker) => ({ id: worker._id, name: workerName(worker) })),
    ...stats.dmClosers.filter((closer) => closer.isActive).map((closer) => ({ id: closer._id, name: closer.displayName })),
  ];
  const href = `/workspace/team/teams/${team._id}`;

  return (
    <li
      className={cn(
        GRID,
        "relative min-h-[58px] border-t border-border py-[9px] first:border-t-0 hover:bg-muted/40 has-[a[data-row-link]:focus-visible]:bg-muted/40 has-[a[data-row-link]:focus-visible]:ring-2 has-[a[data-row-link]:focus-visible]:ring-ring has-[a[data-row-link]:focus-visible]:ring-inset",
      )}
    >
      <span className="min-w-0">
        <Link
          href={href}
          data-row-link
          className={cn(
            "block truncate text-[15px] font-semibold outline-none after:absolute after:inset-0 after:content-['']",
            !team.isActive && "text-muted-foreground",
          )}
        >
          {team.displayName}
        </Link>
        <small className="block truncate font-mono text-[12.5px] tracking-[-0.01em] text-muted-foreground" translate="no">
          utm_source={team.utmSource}
        </small>
      </span>

      <span className="hidden min-w-0 items-center gap-2 @2xl:flex">
        {active.length > 0 ? (
          <span className="flex shrink-0" aria-hidden="true">
            {active.slice(0, 5).map((member) => (
              <Initials key={member.id} name={member.name} size="sm" stacked />
            ))}
          </span>
        ) : null}
        <span className={cn("truncate text-[13px]", active.length === 0 && "text-muted-foreground")}>
          {membersLine(stats)}
        </span>
      </span>

      <span className={cn(FIGURE, "text-right", (!team.isActive || stats.hours === 0) && "font-normal text-muted-foreground")}>
        {team.isActive ? (stats.hours > 0 ? `${formatHours(stats.hours)} h` : "0 h") : "—"}
      </span>

      <span className="hidden min-w-0 @2xl:block">
        <GoalCell team={team} />
      </span>

      <span className="relative z-10 flex items-center gap-2">
        <ActiveWord active={team.isActive} off="Archived" />
        {team.isActive ? null : <ArchiveButton team={team} size="xs" />}
      </span>
    </li>
  );
}

/** "25 booked a day", click to edit; Enter or blur saves, Escape cancels. */
function GoalCell({ team }: { team: TeamDoc }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  const setQuota = useMutation(api.attribution.teams.setTeamBookingQuota);
  const goal = team.bookingDailyQuota;

  async function save(next: number | null, previous: number | null) {
    await setQuota({ teamId: team._id, bookingDailyQuota: next });
    posthog.capture("booking_team_goal_set", { hasGoal: next !== null, from: "team_teams" });
    toast.success(next === null ? `${team.displayName} has no goal` : `${team.displayName}: ${next} booked a business day`, {
      action: {
        label: "Undo",
        onClick: () => {
          setQuota({ teamId: team._id, bookingDailyQuota: previous }).catch((error: unknown) => {
            reportClientError(error, { flow: "booking_team_goal_undo" });
            toast.error(getErrorMessage(error, "Couldn’t undo that change."));
          });
        },
      },
    });
  }

  async function commit() {
    const raw = draft.trim();
    const next = raw === "" ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next < 0 || next > MAX_DAILY_GOAL)) {
      toast.error(`Enter a whole number from 0 to ${MAX_DAILY_GOAL}, or leave it blank for no goal.`);
      return;
    }
    const previous = goal ?? null;
    if (next === previous) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await save(next, previous);
      setEditing(false);
    } catch (error) {
      reportClientError(error, { flow: "booking_team_goal_set" });
      toast.error(getErrorMessage(error, "Couldn’t save the goal."));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="relative z-10 flex items-center gap-2">
        <Input
          autoFocus
          value={draft}
          inputMode="numeric"
          placeholder="No goal"
          aria-label={`Booked calls a business day for ${team.displayName}`}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (cancelled.current) cancelled.current = false;
            else void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelled.current = true;
              setEditing(false);
            }
          }}
          className="h-8 w-[72px] font-condensed text-[15px] tabular-nums"
        />
        <span className="text-[12.5px] whitespace-nowrap text-muted-foreground">a day</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        cancelled.current = false;
        setDraft(goal === undefined ? "" : String(goal));
        setEditing(true);
      }}
      aria-label={`${goal === undefined ? "Set" : "Change"} the daily booked goal for ${team.displayName}`}
      title="Booked calls a business day. Click to change."
      className="group/goal relative z-10 -mx-1.5 inline-flex min-h-7 max-w-full items-baseline gap-1 rounded-[5.6px] px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      {goal === undefined ? (
        <span className="text-[13px] text-muted-foreground">No goal</span>
      ) : (
        <>
          <span className={FIGURE}>{goal}</span>
          <span className="text-[13px] whitespace-nowrap text-muted-foreground">booked a day</span>
        </>
      )}
      <PencilIcon
        aria-hidden="true"
        className="size-3 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover/goal:opacity-100 group-focus-visible/goal:opacity-100"
      />
    </button>
  );
}

export function TeamsTableSkeleton() {
  return (
    <div role="status" aria-label="Loading teams" className={CARD}>
      <div aria-hidden="true" className="flex h-11 items-center border-b border-border px-4">
        <Skeleton className="h-4 w-40" />
      </div>
      <div aria-hidden="true" className={cn(GRID, "min-h-[34px] border-b border-border pt-3 pb-2")}>
        <span className={LABEL}>Team</span>
        <span className={cn(LABEL, "hidden @2xl:block")}>Members</span>
        <span className={cn(LABEL, "text-right")}>Hours a week</span>
        <span className={cn(LABEL, "hidden @2xl:block")}>Booked goal</span>
        <span className={LABEL}>Status</span>
      </div>
      <div aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={cn(GRID, "h-[58px] border-t border-border first:border-t-0")}>
            <span className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-44" />
            </span>
            <Skeleton className="hidden h-5 w-40 @2xl:block" />
            <Skeleton className="ml-auto h-4 w-10" />
            <Skeleton className="hidden h-4 w-28 @2xl:block" />
            <Skeleton className="h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}
