"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { PencilIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import type { Board, Coverage, CoverageTeam } from "../booking-model";
import { routesLine, teamAccess } from "./team-access";
import { ActiveWord, CARD, FIGURE, HelpTip, Initials, LABEL } from "./team-ui";

// Mirrors MAX_BOOKING_DAILY_QUOTA in convex/attribution/teams.ts.
const MAX_DAILY_GOAL = 5000;

/** Concept B's teams grid, folding columns away as the page narrows. */
const GRID =
  "grid items-center gap-3.5 px-4 grid-cols-[minmax(0,1fr)_56px_76px] @2xl:grid-cols-[minmax(170px,1.4fr)_130px_minmax(130px,1fr)_70px_84px] @5xl:grid-cols-[minmax(190px,1.4fr)_150px_minmax(150px,1fr)_150px_84px_92px]";

export type RosterCloser = { _id: string; teamId: string; displayName: string; isActive: boolean };

export function TeamsTable({
  coverage,
  board,
  bookings,
  closers,
}: {
  coverage: Coverage;
  board: Board;
  bookings: Record<string, number>;
  closers: readonly RosterCloser[];
}) {
  const teams = [...coverage.teams].sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      (bookings[b._id] ?? 0) - (bookings[a._id] ?? 0) ||
      a.displayName.localeCompare(b.displayName),
  );

  return (
    <section className={CARD} aria-label="DM teams">
      <div className={cn(GRID, "relative z-10 min-h-[34px] border-b border-border pt-3 pb-2")}>
        <span className={LABEL}>
          <HelpTip tip="A DM team is one utm_source: every link its DM closers copy carries it, and bookings with it are credited to the team.">
            DM team
          </HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @2xl:block")}>
          <HelpTip tip="Booked calls the team should make each business day. Booked Calls draws the team's goal ring from it. Click a goal to change it.">
            Goal
          </HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @2xl:block")}>
          <HelpTip tip="The team's DM closers: active ones can copy links in the portal; disabled ones keep their history.">Roster</HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @5xl:block")}>
          <HelpTip tip="How many programs the team's DM closers can get a working link for, and where those links come from (its own routes or Shared). Set on Coverage.">
            Can book
          </HelpTip>
        </span>
        <span className={cn(LABEL, "text-right")}>
          <HelpTip tip="Bookings made in the last 30 days through links with this team's utm_source.">Booked 30d</HelpTip>
        </span>
        <span className={LABEL}>
          <HelpTip tip="Active teams appear in the link portal and get credit for bookings. Disabled teams keep their history.">Status</HelpTip>
        </span>
      </div>
      {teams.length === 0 ? (
        <p className="px-4 py-5 text-[14px] text-muted-foreground">
          No DM teams yet. A DM team is one utm_source; its DM closers’ links carry it. Add one with New DM team.
        </p>
      ) : (
        <ul>
          {teams.map((team) => (
            <TeamRow
              key={team._id}
              team={team}
              board={board}
              coverage={coverage}
              booked={bookings[team._id] ?? 0}
              roster={closers.filter((closer) => closer.teamId === team._id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamRow({
  team,
  board,
  coverage,
  booked,
  roster,
}: {
  team: CoverageTeam;
  board: Board;
  coverage: Coverage;
  booked: number;
  roster: readonly RosterCloser[];
}) {
  const active = roster.filter((closer) => closer.isActive);
  const access = teamAccess(board, coverage, team);
  const href = `/workspace/booking/teams/${team._id}`;

  return (
    <li
      className={cn(
        GRID,
        "relative border-t border-border py-[11px] first:border-t-0 hover:bg-muted/40 has-[a[data-row-link]:focus-visible]:bg-muted/40 has-[a[data-row-link]:focus-visible]:ring-2 has-[a[data-row-link]:focus-visible]:ring-ring has-[a[data-row-link]:focus-visible]:ring-inset",
      )}
    >
      <span className="min-w-0">
        <Link
          href={href}
          data-row-link
          className="block truncate text-[15px] font-semibold outline-none after:absolute after:inset-0 after:content-['']"
        >
          {team.displayName}
        </Link>
        <small className="block truncate font-mono text-[12.5px] tracking-[-0.01em] text-muted-foreground" translate="no">
          utm_source={team.utmSource}
        </small>
      </span>

      <span className="hidden min-w-0 @2xl:block">
        <GoalCell team={team} />
      </span>

      <span className="hidden min-w-0 @2xl:block">
        {active.length > 0 ? (
          <span className="flex" aria-hidden="true">
            {active.slice(0, 5).map((closer) => (
              <Initials key={closer._id} name={closer.displayName} size="sm" stacked />
            ))}
          </span>
        ) : null}
        <small className="mt-0.5 block text-[12.5px] text-muted-foreground">
          {active.length} active · {roster.length - active.length} disabled
        </small>
      </span>

      <span className="hidden min-w-0 @5xl:block">
        {team.isActive ? (
          <>
            <span className={cn(FIGURE, access.bookable === 0 && access.total > 0 && "text-warning-ink")}>
              {access.bookable}
            </span>{" "}
            <span className="text-[12.5px] text-muted-foreground">
              of {access.total} {access.total === 1 ? "program" : "programs"}
            </span>
            <small className="block truncate text-[12.5px] text-muted-foreground">
              {routesLine(access, team.usesShared)}
            </small>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>

      <span className={cn(FIGURE, "text-right", booked === 0 && "font-normal text-muted-foreground")}>{booked}</span>

      <span>
        <ActiveWord active={team.isActive} />
      </span>
    </li>
  );
}

/** "25 a business day", click to edit; Enter or blur saves, Escape cancels. */
function GoalCell({ team }: { team: CoverageTeam }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  const setQuota = useMutation(api.attribution.teams.setTeamBookingQuota);
  const goal = team.bookingDailyQuota;

  async function save(next: number | null, previous: number | null) {
    await setQuota({ teamId: team._id as Id<"attributionTeams">, bookingDailyQuota: next });
    posthog.capture("booking_team_goal_set", { hasGoal: next !== null });
    toast.success(next === null ? `${team.displayName} has no goal` : `${team.displayName}: ${next} a business day`, {
      action: {
        label: "Undo",
        onClick: () => {
          setQuota({ teamId: team._id as Id<"attributionTeams">, bookingDailyQuota: previous }).catch((error: unknown) => {
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
      aria-label={`${goal === undefined ? "Set" : "Change"} the daily goal for ${team.displayName}`}
      title="Booked calls a business day. Click to change."
      className="group/goal relative z-10 -mx-1.5 inline-flex min-h-7 max-w-full items-baseline gap-1 rounded-[5.6px] px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      {goal === undefined ? (
        <span className="text-[14px] text-muted-foreground">No goal</span>
      ) : (
        <>
          <span className={FIGURE}>{goal}</span>
          <span className="text-[12.5px] whitespace-nowrap text-muted-foreground">a business day</span>
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
    <div role="status" aria-label="Loading DM teams" className={CARD}>
      <div aria-hidden="true" className={cn(GRID, "min-h-[34px] border-b border-border pt-3 pb-2")}>
        <span className={LABEL}>DM team</span>
        <span className={cn(LABEL, "hidden @2xl:block")}>Goal</span>
        <span className={cn(LABEL, "hidden @2xl:block")}>Roster</span>
        <span className={cn(LABEL, "hidden @5xl:block")}>Can book</span>
        <span className={cn(LABEL, "text-right")}>Booked 30d</span>
        <span className={LABEL}>Status</span>
      </div>
      <div aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className={cn(GRID, "h-[65px] border-t border-border first:border-t-0")}>
          <span className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-44" />
          </span>
          <Skeleton className="hidden h-4 w-28 @2xl:block" />
          <Skeleton className="hidden h-5 w-24 @2xl:block" />
          <Skeleton className="hidden h-4 w-28 @5xl:block" />
          <Skeleton className="ml-auto h-4 w-8" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
      </div>
    </div>
  );
}
