"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import {
  buildBoard,
  modeLabel,
  modeOf,
  type Board,
  type CoverageTeam,
} from "@/app/workspace/booking/_components/booking-model";
import { CalendlyDot } from "@/app/workspace/booking/_components/calendly-dot";
import { DmCloserDialog } from "./dm-closer-dialog";
import { RosterCard } from "./roster-card";
import { formatHours, weekTotal, WeekStrip, type WeekHours } from "../schedule-editor";
import { teamAccess, type TeamAccess } from "./team-access";
import { useTeamsDirectory, workerName, type LeadGenWorker } from "./teams-data";
import { ActiveWord, CardHead, CARD, daysAgo, FIGURE, HelpTip, Initials, LABEL, plural } from "../team-ui";
import { MemberCardHost, useMemberCardHref } from "../member-card/member-card-host";

type CopyEvent = FunctionReturnType<typeof api.linkPortal.copyQueries.listRecentCopyEvents>[number];

const COPY_LIMIT = 100;

/**
 * A team's page: its DM closers, each editable in a modal (`?closer=<id>`,
 * `&schedule=1` opens their week), and its lead generators, each opening
 * their member card. What the closers' links book stays in Booking setup;
 * the page links to the team's column on Coverage. The band above shows the
 * team's title, figures, Edit team and Archive.
 */
export function TeamPageClient() {
  const { teamId } = useParams<{ teamId: string }>();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const directory = useTeamsDirectory();
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const teamMembers = useQuery(api.users.queries.listTeamMembers, {});
  const presets = useQuery(api.linkPortal.campaignQueries.listCampaignPresetsForSettings, {});
  const copies = useQuery(api.linkPortal.copyQueries.listRecentCopyEvents, { limit: COPY_LIMIT });
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);
  const team = coverage?.teams.find((row) => row._id === teamId);
  usePageTitle(team ? `${team.displayName} · Teams` : "Team");
  useBreadcrumbTrail(
    team
      ? [
          { label: "Home", href: "/workspace" },
          { label: "Team", href: "/workspace/team" },
          { label: "Teams", href: "/workspace/team/teams" },
          { label: team.displayName, href: pathname },
        ]
      : null,
  );

  const openId = searchParams.get("closer");
  // `?closer=<id>&schedule=1` lands on that DM closer with the schedule open.
  const scheduleOpen = searchParams.get("schedule") === "1";
  const [creating, setCreating] = useState(false);

  function setOpen(dmCloserId: string | null, schedule = false) {
    const query = dmCloserId ? `?closer=${dmCloserId}${schedule ? "&schedule=1" : ""}` : "";
    window.history.replaceState(null, "", `${pathname}${query}`);
  }

  const loaded =
    coverage !== undefined && activity !== undefined && directory !== undefined && board !== null;

  // Arriving with ?closer=, bring that row into view once.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!loaded || scrolled.current || !openId) return;
    scrolled.current = true;
    document.getElementById(`row-${openId}`)?.scrollIntoView({ block: "nearest" });
  }, [loaded, openId]);

  if (!loaded) return <TeamPageSkeleton />;
  if (!team) return <TeamNotFound />;

  const stats = directory.statsFor(team._id);
  const access = teamAccess(board, coverage, team);
  const campaignPreset = presets?.find((preset) => preset.isActive && preset.isDefault) ?? presets?.find((preset) => preset.isActive);
  const campaign = campaignPreset ? { label: campaignPreset.label, utmCampaign: campaignPreset.utmCampaign } : null;

  return (
    <div className="grid min-w-0 items-start gap-3.5 short:gap-3 @5xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
        <RosterCard
          team={team}
          teams={directory.teams}
          closers={stats.dmClosers}
          allClosers={directory.closers}
          bookings={activity.bookings30d.dmClosers}
          teamMembers={teamMembers ?? []}
          access={access}
          campaign={campaign}
          unmatched={activity.unmatchedUtms}
          openId={openId}
          scheduleOpen={scheduleOpen}
          schedules={directory.dmWeeks}
          onToggle={(dmCloserId) => setOpen(openId === dmCloserId ? null : dmCloserId)}
          onScheduleChange={(dmCloserId, open) => {
            // A save can settle after its modal closed; don't reopen it.
            if (new URLSearchParams(window.location.search).get("closer") !== dmCloserId) return;
            setOpen(dmCloserId, open);
          }}
          onNew={() => setCreating(true)}
        />
        <LeadGenCard teamName={team.displayName} workers={stats.leadGen} weeks={directory.leadGenWeeks} />
      </div>
      <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
        <BookingLinksCard team={team} access={access} activeDm={stats.activeDm} />
        <RecentCopies teamId={team._id} copies={copies} board={board} onOpenCloser={setOpen} />
      </div>
      <DmCloserDialog
        open={creating}
        onOpenChange={setCreating}
        teams={directory.teams}
        teamMembers={teamMembers ?? []}
        defaults={{ teamId: team._id }}
        onSaved={(dmCloserId) => setOpen(dmCloserId)}
      />
      <MemberCardHost />
    </div>
  );
}

const LEAD_GEN_ROW =
  "grid w-full items-center gap-2.5 px-4 text-left grid-cols-[28px_minmax(0,1fr)_44px_72px_14px] @lg/leadgen:grid-cols-[28px_minmax(0,1fr)_auto_44px_72px_14px]";

/**
 * The team's lead generators: name, week strip, hours, status. A row opens
 * their member card here, in place, with their lead gen week.
 */
function LeadGenCard({
  teamName,
  workers,
  weeks,
}: {
  teamName: string;
  workers: readonly LeadGenWorker[];
  weeks: ReadonlyMap<string, WeekHours>;
}) {
  const rows = [...workers].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || workerName(a).localeCompare(workerName(b)),
  );
  const active = rows.filter((worker) => worker.isActive).length;
  const memberHref = useMemberCardHref();
  const members = useQuery(api.team.directory.getDirectory, {})?.members;
  const keyOf = new Map<string, string>();
  for (const member of members ?? []) for (const record of member.leadGen) keyOf.set(record.workerId, member.key);
  const pathname = usePathname();
  // Until the directory loads, the worker alias opens the same card.
  const hrefFor = (workerId: string) => {
    const key = keyOf.get(workerId);
    return key ? memberHref(key, "lead_gen") : `${pathname}?worker=${workerId}&schedule=lead_gen`;
  };
  return (
    <section className={cn(CARD, "@container/leadgen")} aria-labelledby="leadgen-title">
      <CardHead
        title={<span id="leadgen-title">Lead gen</span>}
        meta={`${plural(active, "active lead generator")} · open one to set their week`}
      />
      <div className={cn(LEAD_GEN_ROW, "min-h-[34px] border-b border-border pt-2.5 pb-2")}>
        <span />
        <span className={LABEL}>
          <HelpTip tip="Lead generators whose captures count for this team on Lead Gen. Click one to open their member card.">
            Lead generator
          </HelpTip>
        </span>
        <span className={cn(LABEL, "hidden @lg/leadgen:block")}>
          <HelpTip tip="Their lead gen week in force today: hours each weekday. Lead Gen divides their captures by these hours.">
            Week
          </HelpTip>
        </span>
        <span className={cn(LABEL, "text-right")}>
          <HelpTip tip="Hours scheduled a week as a lead generator.">Hours</HelpTip>
        </span>
        <span className={LABEL}>
          <HelpTip tip="Active lead generators can log captures. Inactive ones keep their history.">Status</HelpTip>
        </span>
        <span />
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-[14px] text-muted-foreground">
          No lead generators on {teamName}. Put someone on it from their member card.
        </p>
      ) : (
        <ul>
          {rows.map((worker) => {
            const week = weeks.get(worker._id) ?? null;
            const total = weekTotal(week);
            const name = workerName(worker);
            return (
              <li key={worker._id} className="border-t border-border first:border-t-0">
                <Link
                  href={hrefFor(worker._id)}
                  scroll={false}
                  aria-label={`Open ${name}`}
                  className={cn(
                    LEAD_GEN_ROW,
                    "min-h-14 py-[9px] text-[14px] outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    !worker.isActive && "text-muted-foreground",
                  )}
                >
                  <Initials name={name} />
                  <span className="min-w-0">
                    <b className="block truncate font-semibold">{name}</b>
                    <small className="block truncate text-[12px] text-muted-foreground">{worker.email}</small>
                  </span>
                  <WeekStrip week={week} className="hidden @lg/leadgen:inline-flex" />
                  <span
                    className={cn(
                      "text-right",
                      total > 0 ? cn(FIGURE, "text-[14px]") : "text-[13px] text-muted-foreground",
                    )}
                  >
                    {total > 0 ? `${formatHours(total)}h` : "None"}
                  </span>
                  <ActiveWord active={worker.isActive} off="Inactive" />
                  <ChevronRightIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What the team's closers' links book stays in Booking setup; this links there. */
function BookingLinksCard({ team, access, activeDm }: { team: CoverageTeam; access: TeamAccess; activeDm: number }) {
  return (
    <section className={CARD} aria-labelledby="booking-links-title">
      <CardHead title={<span id="booking-links-title">Booking links</span>} meta="Stays in Booking setup" />
      <p className="px-4 py-3 text-[13.5px]">
        {team.isActive ? (
          <>
            <b className="font-semibold">
              {access.bookable} of {plural(access.total, "program")}
            </b>{" "}
            can be booked from {team.displayName}’s portal links.
          </>
        ) : (
          <>{team.displayName} is archived, so its DM closers get no links.</>
        )}{" "}
        <span className="text-muted-foreground">
          Which event type each link books depends on event types and programs, so it stays on Coverage, next to them.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-2.5">
        <span className="text-[13px] text-muted-foreground">
          {activeDm === 0 ? "No active DM closers copy these links" : `${plural(activeDm, "DM closer")} copy these links`}
        </span>
        <Link
          href={`/workspace/booking?team=${team._id}`}
          className="ml-auto inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-semibold underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          What its closers get, on Coverage
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
      <h2 className="text-[15px] font-semibold">This team doesn’t exist</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        It may have been deleted, or the link points to another workspace.
      </p>
      <Link
        href="/workspace/team/teams"
        className="mt-3 inline-flex min-h-6 items-center gap-1 rounded-sm text-[13px] font-semibold underline decoration-foreground/40 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
        Back to Teams
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
    <div role="status" aria-label="Loading team" className="grid items-start gap-3.5 @5xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {card(4, "DM closers")}
      {card(3, "Booking links")}
    </div>
  );
}
