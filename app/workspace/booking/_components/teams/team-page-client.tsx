"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import posthog from "posthog-js";
import { ArrowRightIcon, ChevronLeftIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { buildBoard, modeLabel, modeOf, type Board, type CoverageTeam } from "../booking-model";
import { CalendlyDot } from "../calendly-dot";
import { DmCloserDialog } from "../dm-closer-dialog";
import { GetsRows } from "./gets-table";
import { RosterCard } from "./roster-card";
import { EMPTY_WEEK, type WeekHours } from "./schedule-editor";
import { teamAccess, type TeamAccess } from "./team-access";
import { CardHead, CARD, daysAgo, Initials, teamShortName, HelpTip } from "./team-ui";

type CopyEvent = FunctionReturnType<typeof api.linkPortal.copyQueries.listRecentCopyEvents>[number];

const COPY_LIMIT = 100;

/**
 * A DM team's page (concept B): the roster, each DM closer editable in place
 * (`?closer=<id>` opens one), and what the team's closers get per program and
 * lane, with the reason. The band above shows the team's title and figures.
 */
export function TeamPageClient() {
  const { teamId } = useParams<{ teamId: string }>();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const scheduleRows = useQuery(api.workSchedules.listDmCloserSchedules, {});
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});
  const presets = useQuery(api.linkPortal.campaignQueries.listCampaignPresetsForSettings, {});
  const copies = useQuery(api.linkPortal.copyQueries.listRecentCopyEvents, { limit: COPY_LIMIT });
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);
  const team = coverage?.teams.find((row) => row._id === teamId);
  usePageTitle(team?.displayName ?? "DM team");
  useBreadcrumbTrail(
    team
      ? [
          { label: "Home", href: "/workspace" },
          { label: "Booking setup", href: "/workspace/booking" },
          { label: "DM teams", href: "/workspace/booking/teams" },
          { label: team.displayName, href: pathname },
        ]
      : null,
  );

  const openId = searchParams.get("closer");
  // `?closer=<id>&schedule=1` lands on that DM closer with the schedule open.
  const scheduleOpen = searchParams.get("schedule") === "1";
  const [creating, setCreating] = useState(false);
  const schedules = useMemo(() => {
    const byCloser = new Map<string, WeekHours>();
    for (const row of scheduleRows?.schedules ?? []) {
      const week = byCloser.get(row.dmCloserId) ?? { ...EMPTY_WEEK };
      week[row.weekday] = row.scheduledHours;
      byCloser.set(row.dmCloserId, week);
    }
    return byCloser;
  }, [scheduleRows]);

  function setOpen(dmCloserId: string | null, schedule = false) {
    const query = dmCloserId ? `?closer=${dmCloserId}${schedule ? "&schedule=1" : ""}` : "";
    window.history.replaceState(null, "", `${pathname}${query}`);
  }

  const loaded =
    coverage !== undefined &&
    activity !== undefined &&
    closers !== undefined &&
    teams !== undefined &&
    scheduleRows !== undefined &&
    board !== null;

  // Arriving with ?closer=, bring that row into view once.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!loaded || scrolled.current || !openId) return;
    scrolled.current = true;
    document.getElementById(`row-${openId}`)?.scrollIntoView({ block: "nearest" });
  }, [loaded, openId]);

  if (!loaded) return <TeamPageSkeleton />;
  if (!team) return <TeamNotFound />;

  const access = teamAccess(board, coverage, team);
  const campaignPreset = presets?.find((preset) => preset.isActive && preset.isDefault) ?? presets?.find((preset) => preset.isActive);
  const campaign = campaignPreset ? { label: campaignPreset.label, utmCampaign: campaignPreset.utmCampaign } : null;

  return (
    <div className="grid min-w-0 items-start gap-3.5 short:gap-3 @5xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <RosterCard
        team={team}
        teams={teams}
        closers={closers.filter((closer) => closer.teamId === team._id)}
        allClosers={closers}
        bookings={activity.bookings30d.dmClosers}
        teamMembers={teamMembers ?? []}
        access={access}
        campaign={campaign}
        unmatched={activity.unmatchedUtms}
        openId={openId}
        scheduleOpen={scheduleOpen}
        schedules={schedules}
        onToggle={(dmCloserId) => setOpen(openId === dmCloserId ? null : dmCloserId)}
        onScheduleChange={(dmCloserId, open) => {
          // A save can settle after its modal closed; don't reopen it.
          if (new URLSearchParams(window.location.search).get("closer") !== dmCloserId) return;
          setOpen(dmCloserId, open);
        }}
        onNew={() => setCreating(true)}
      />
      <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
        <TeamGetsCard team={team} access={access} />
        <RecentCopies teamId={team._id} copies={copies} board={board} onOpenCloser={setOpen} />
      </div>
      <DmCloserDialog
        open={creating}
        onOpenChange={setCreating}
        teams={teams}
        teamMembers={teamMembers ?? []}
        defaults={{ teamId: team._id }}
        onSaved={(dmCloserId) => setOpen(dmCloserId)}
      />
    </div>
  );
}

function TeamGetsCard({ team, access }: { team: CoverageTeam; access: TeamAccess }) {
  const setTeamUsesShared = useMutation(api.bookingSetup.mutations.setTeamUsesShared);
  const switchId = `uses-shared-${team._id}`;

  async function toggle(usesShared: boolean) {
    try {
      await setTeamUsesShared({ teamId: team._id, usesShared });
      posthog.capture("booking_team_uses_shared_set", { usesShared, from: "team_page" });
      toast.success(
        usesShared ? `${team.displayName} now uses Shared in empty cells` : `${team.displayName} no longer uses Shared`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              setTeamUsesShared({ teamId: team._id, usesShared: !usesShared }).catch((error: unknown) => {
                reportClientError(error, { flow: "booking_team_uses_shared_undo" });
                toast.error(getErrorMessage(error, "Couldn’t undo that change."));
              });
            },
          },
        },
      );
    } catch (error) {
      reportClientError(error, { flow: "booking_team_uses_shared_set" });
      toast.error(getErrorMessage(error, "Couldn’t change this team."));
    }
  }

  return (
    <section className={CARD} aria-labelledby="gets-title">
      <CardHead
        title={<span id="gets-title">What {teamShortName(team.displayName)}’s closers get</span>}
        meta="Per program and lane, with the reason"
      />
      {!team.isActive ? (
        <p className="border-b border-border bg-warning-surface px-4 py-2 text-[13px] text-warning-ink">
          {team.displayName} is disabled, so its DM closers get no links. This is what they’d get with it enabled.
        </p>
      ) : null}
      {access.rows.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">No programs yet.</p>
      ) : (
        <div className="[&_[role=row]]:px-4">
          <GetsRows rows={access.rows} teamId={team._id} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-2.5">
        <label htmlFor={switchId} className="flex min-w-0 flex-[1_1_240px] items-start gap-2.5">
          <Switch
            id={switchId}
            checked={team.usesShared}
            onCheckedChange={(checked) => void toggle(checked)}
            className="mt-0.5 data-checked:bg-foreground"
          />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">
              <HelpTip tip="Shared is Coverage's fallback column. With this on, any program and lane where the team has no event type of its own uses the Shared cell's event type instead.">
                Uses Shared
              </HelpTip>
            </span>
            <span className="block text-[12.5px] text-muted-foreground">
              {team.usesShared
                ? "A program and lane without its own route gets the Shared link."
                : "Only its own routes. Lanes without one aren’t offered to this team."}
            </span>
          </span>
        </label>
        <Link
          href={`/workspace/booking?team=${team._id}`}
          className="ml-auto inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-semibold underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Change on Coverage
          <ArrowRightIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}

/** "45 min ago", "3 h ago", "yesterday". */
function ago(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return daysAgo(timestamp, now);
}

function RecentCopies({
  teamId,
  copies,
  board,
  onOpenCloser,
}: {
  teamId: Id<"attributionTeams">;
  copies: CopyEvent[] | undefined;
  board: Board;
  onOpenCloser: (dmCloserId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [now] = useState(() => Date.now());
  const mine = copies?.filter((copy) => copy.attributionTeamId === teamId) ?? [];
  const shown = showAll ? mine : mine.slice(0, 5);
  const partial = copies !== undefined && copies.length >= COPY_LIMIT;

  return (
    <section className={CARD} aria-labelledby="copies-title">
      <CardHead
        title={<span id="copies-title">Recent link copies</span>}
        meta={partial ? `This team’s, among the portal’s last ${COPY_LIMIT}` : "This team’s copies"}
      >
        {mine.length > 5 ? (
          <Button variant="link" size="sm" className="h-6 px-0" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${mine.length}`}
          </Button>
        ) : null}
      </CardHead>
      {copies === undefined ? (
        <div role="status" aria-label="Loading link copies" className="flex flex-col gap-2 px-4 py-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : mine.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">No copies yet. They show here when this team’s DM closers copy a link in the portal.</p>
      ) : (
        <ul>
          {shown.map((copy) => {
            const eventType = board.eventTypesById.get(copy.eventTypeConfigId);
            return (
              <li key={copy.id} className="flex items-start gap-3 border-t border-border px-4 py-[9px] first:border-t-0">
                <span className="mt-0.5">
                  <Initials name={copy.dmCloserName} />
                </span>
                <span className="min-w-0 flex-1 text-[14px]">
                  <button
                    type="button"
                    onClick={() => onOpenCloser(copy.dmCloserId)}
                    className="rounded-sm text-left text-[14px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {copy.dmCloserName}
                  </button>
                  <small className="block truncate text-[12.5px] text-muted-foreground">
                    {copy.bookingProgramName}
                    {eventType ? ` · ${modeLabel(modeOf(eventType))}` : ""} · {copy.campaignLabel}
                  </small>
                  <small className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    <CalendlyDot color={eventType?.calendlyColor} className="size-2.5" />
                    <span className="truncate">{copy.eventTypeName}</span>
                  </small>
                </span>
                <time
                  dateTime={new Date(copy.copiedAt).toISOString()}
                  title={new Date(copy.copiedAt).toLocaleString()}
                  className="text-[12.5px] whitespace-nowrap text-muted-foreground"
                >
                  {ago(copy.copiedAt, now)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TeamNotFound() {
  return (
    <section className={cn(CARD, "px-4 py-6")}>
      <h2 className="text-[15px] font-semibold">This DM team doesn’t exist</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        It may have been deleted, or the link points to another workspace.
      </p>
      <Link
        href="/workspace/booking/teams"
        className="mt-3 inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-semibold underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
        Back to DM teams
      </Link>
    </section>
  );
}

export function TeamPageSkeleton() {
  const card = (rows: number, label: string) => (
    <div className={CARD} aria-hidden="true">
      <div className="flex h-11 items-center px-4">
        <Skeleton className="h-4 w-40" />
        <span className="sr-only">{label}</span>
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-14 items-center gap-3 border-t border-border px-4">
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
  return (
    <div role="status" aria-label="Loading DM team" className="grid items-start gap-3.5 @5xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {card(4, "Roster")}
      {card(6, "What the team’s closers get")}
    </div>
  );
}
