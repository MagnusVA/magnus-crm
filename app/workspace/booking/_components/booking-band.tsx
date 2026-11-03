"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { AttributionTeamDialog } from "./attribution-team-dialog";
import { buildBoard, eventTypeStatus, SCHEDULING_MODES, type Board, type Coverage } from "./booking-model";

export { BOOKING_ROOT_CLASS as BOOKING_ROOT } from "./booking-layout";

export type BookingSection = "coverage" | "inbox" | "event-types" | "teams" | "team" | "portal";
type Activity = FunctionReturnType<typeof api.bookingSetup.queries.getBookingActivity>;

export function sectionFromPath(pathname: string): BookingSection {
  if (pathname.startsWith("/workspace/booking/inbox")) return "inbox";
  if (pathname.startsWith("/workspace/booking/event-types")) return "event-types";
  if (pathname.startsWith("/workspace/booking/teams/")) return "team";
  if (pathname.startsWith("/workspace/booking/teams")) return "teams";
  if (pathname.startsWith("/workspace/booking/portal")) return "portal";
  return "coverage";
}

const TITLE: Record<Exclude<BookingSection, "team">, string> = {
  coverage: "Booking setup",
  inbox: "Inbox",
  "event-types": "Booking setup",
  teams: "DM teams",
  portal: "Booking setup",
};

const DESCRIPTION: Record<Exclude<BookingSection, "team">, string> = {
  coverage: "Who can book what: every program against every DM team, and the exact link each DM closer gets.",
  inbox: "Calendly event types nobody has sorted yet. File each one under a program and lane, or set it aside as not a sales call.",
  "event-types": "Calendly’s event types, sorted: sales calls, the unsorted, look-alikes and the noise.",
  teams: "External setters who send booking links: a team is a utm_source, each DM closer a utm_medium. Open a team to see exactly what its closers get.",
  portal: "The password-protected page where DM closers copy their links, and what they did with it.",
};

const TABS: Array<{ section: BookingSection; href: string; label: string }> = [
  { section: "coverage", href: "/workspace/booking", label: "Coverage" },
  { section: "inbox", href: "/workspace/booking/inbox", label: "Inbox" },
  { section: "event-types", href: "/workspace/booking/event-types", label: "Event types" },
  { section: "teams", href: "/workspace/booking/teams", label: "DM teams" },
  { section: "portal", href: "/workspace/booking/portal", label: "Link portal" },
];

const LABEL =
  "font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] whitespace-nowrap text-board-muted uppercase";

/**
 * The booking setup band, rendered once by the section's layout so it stays
 * mounted while the tabs change. The title and figures follow the section
 * (concept C's band for Coverage, Event types and Link portal; concept B's
 * figures for the Inbox and DM teams), and the tab row never moves.
 *
 * It also moves a tenant onto booking coverage the first time an admin opens
 * any section (`ensureCoverage` does nothing after that).
 */
export function BookingBand() {
  const pathname = usePathname();
  const params = useParams<{ teamId?: string }>();
  const section = sectionFromPath(pathname);
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const board = useMemo(() => (coverage ? buildBoard(coverage) : null), [coverage]);
  useEnsureCoverage(coverage?.migrated);

  const problems = board ? board.figures.noLink + board.figures.broken : 0;
  const unsorted = board?.figures.unsorted ?? 0;
  const lastSync = coverage
    ? Math.max(0, ...coverage.eventTypes.map((eventType) => eventType.lastCalendlySyncedAt ?? 0))
    : 0;
  const team =
    section === "team" && coverage ? coverage.teams.find((row) => row._id === params.teamId) : undefined;

  return (
    <header className="overflow-hidden rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10">
      <div className="dark flex flex-col px-4 pt-3.5 @lg:px-[18px]">
        <div className="flex min-h-[78px] flex-wrap items-end gap-x-[18px] gap-y-3 pb-3">
          <div className="min-w-0 flex-[1_1_260px]">
            {section === "team" ? (
              <Link
                href="/workspace/booking/teams"
                className="-ml-1 mb-1.5 inline-flex min-h-6 items-center gap-1 rounded-sm pr-1.5 text-[13px] font-medium text-board-muted outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeftIcon className="size-4" aria-hidden="true" />
                DM teams
              </Link>
            ) : null}
            <h1 className="flex flex-wrap items-center gap-2.5 text-[26px] leading-[1.1] font-semibold tracking-[-0.01em]">
              {section === "team" ? (team?.displayName ?? "DM team") : TITLE[section]}
              {section === "team" && team ? (
                <span
                  className={cn(
                    "rounded-[4px] border px-1.5 py-0.5 font-condensed text-[11px] font-bold tracking-[0.1em] uppercase",
                    team.isActive
                      ? "border-board-foreground/25 text-board-foreground"
                      : "border-board-foreground/15 text-board-muted",
                  )}
                >
                  {team.isActive ? "Active" : "Disabled"}
                </span>
              ) : null}
            </h1>
            <p className="mt-[5px] max-w-[520px] text-[13px] leading-[19px] text-board-muted @4xl:min-h-[38px]">
              {section === "team" ? team ? <TeamMeta team={team} /> : " " : DESCRIPTION[section]}
            </p>
          </div>
          {board && coverage && activity !== undefined ? (
            <Figures section={section} board={board} coverage={coverage} activity={activity} teamId={team?._id} />
          ) : (
            <div className="h-[62px]" aria-hidden />
          )}
          {section === "team" ? (
            team ? <TeamActions team={team} /> : null
          ) : section === "teams" ? (
            <Button asChild className="self-start">
              <Link href="/workspace/booking/teams?new=team">
                <PlusIcon aria-hidden />
                New DM team
              </Link>
            </Button>
          ) : (
            <PortalStatus />
          )}
        </div>
        <nav
          aria-label="Booking setup sections"
          className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
        >
          {TABS.map((tab) => {
            const active = tab.section === section || (tab.section === "teams" && section === "team");
            const count = tab.section === "coverage" ? problems : tab.section === "inbox" ? unsorted : 0;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className="flex h-10 shrink-0 items-center gap-[7px] border-b-2 border-transparent font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap text-board-muted uppercase outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-primary aria-[current=page]:text-board-foreground"
              >
                {tab.label}
                {count > 0 ? (
                  <span
                    className={cn(
                      "rounded-[4px] bg-board-foreground/8 px-[5px] py-[3px] font-condensed text-[12px] leading-none tracking-[0.02em] tabular-nums",
                      tab.section === "coverage" ? "text-board-danger" : "text-warning",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            );
          })}
          <span className="ml-auto hidden items-center gap-1.5 text-[12.5px] whitespace-nowrap text-board-muted @3xl:flex">
            {coverage ? (
              <>
                <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                {lastSync
                  ? `Calendly synced ${formatDistanceToNowStrict(lastSync, { addSuffix: true })}`
                  : "Not synced with Calendly yet"}
                {" · "}
                {coverage.eventTypes.length} event types
              </>
            ) : null}
          </span>
        </nav>
      </div>
    </header>
  );
}

function Figure({
  label,
  value,
  of,
  caption,
  tone = "default",
  meter,
  href,
}: {
  label: string;
  value: number | string;
  of?: number;
  caption?: string;
  tone?: "default" | "danger" | "warning";
  meter?: number;
  href?: string;
}) {
  const body = (
    <>
      <span className={LABEL}>{label}</span>
      <span
        className={cn(
          "mt-1.5 flex items-baseline gap-px font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums",
          tone === "danger" && "text-board-danger",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
        {of !== undefined ? <small className="text-[17px] font-semibold text-board-muted">/{of}</small> : null}
      </span>
      {meter !== undefined ? (
        <span className="mt-[5px] h-1 w-full overflow-hidden rounded-[2px] bg-board-foreground/12" aria-hidden>
          <i
            className={cn(
              "block h-full transition-[width] duration-700",
              meter >= 1 ? "bg-primary" : "bg-board-foreground/70",
            )}
            style={{ width: `${Math.round(meter * 100)}%` }}
          />
        </span>
      ) : caption ? (
        <span className="text-[12px] whitespace-nowrap text-board-muted">{caption}</span>
      ) : null}
    </>
  );
  const className = "flex min-w-[92px] flex-col border-l border-board-line px-4 py-0.5 text-left";
  return href ? (
    <Link
      href={href}
      className={cn(className, "outline-none hover:bg-board-foreground/5 focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

function Figures({
  section,
  board,
  coverage,
  activity,
  teamId,
}: {
  section: BookingSection;
  board: Board;
  coverage: Coverage;
  activity: Activity;
  teamId?: Id<"attributionTeams">;
}) {
  const { figures } = board;
  if (section === "inbox") {
    const counts = { sorted: 0, not_sales_call: 0, gone: 0 };
    for (const eventType of coverage.eventTypes) {
      const status = eventTypeStatus(eventType);
      if (status !== "unsorted") counts[status] += 1;
    }
    return (
      <div className="flex flex-wrap">
        <Figure
          label="To sort"
          value={figures.unsorted}
          caption="event types"
          tone={figures.unsorted ? "warning" : "default"}
        />
        <Figure label="On a program" value={counts.sorted} caption="sales calls" href="/workspace/booking/event-types" />
        <Figure
          label="Not a sales call"
          value={counts.not_sales_call}
          caption="set aside"
          href="/workspace/booking/event-types?filter=not_sales_call"
        />
        <Figure label="Gone" value={counts.gone} caption="off in Calendly" href="/workspace/booking/event-types?filter=gone" />
      </div>
    );
  }
  if (section === "teams") {
    const active = coverage.teams.filter((team) => team.isActive);
    const closers = active.reduce((sum, team) => sum + team.activeDmClosers, 0);
    const credited = Object.values(activity.bookings30d.teams).reduce((sum, count) => sum + count, 0);
    const unmatchedBookings = activity.unmatchedUtms.reduce((sum, row) => sum + row.bookings, 0);
    return (
      <div className="flex flex-wrap">
        <Figure label="Active teams" value={active.length} caption={`${coverage.teams.length - active.length} disabled`} />
        <Figure label="Active DM closers" value={closers} caption="on active teams" />
        <Figure label="Booked via DM links · 30d" value={credited} caption="credited by utm_source" />
        <Figure
          label="Unmatched UTMs"
          value={activity.unmatchedUtms.length}
          caption={`${unmatchedBookings} booking${unmatchedBookings === 1 ? "" : "s"} credited to nobody`}
          tone={activity.unmatchedUtms.length ? "warning" : "default"}
        />
      </div>
    );
  }
  if (section === "team") {
    const team = coverage.teams.find((row) => row._id === teamId);
    if (!team) return null;
    let canBook = 0;
    let firstGap: string | null = null;
    for (const program of board.programs) {
      const works = SCHEDULING_MODES.some((mode) => {
        const cell = board.teamCell(team, program._id, mode);
        return cell.kind !== "none" && cell.issue === null;
      });
      if (works) canBook += 1;
      else firstGap ??= program.name;
    }
    return (
      <div className="flex flex-wrap">
        <Figure
          label="Booked · 30 days"
          value={activity.bookings30d.teams[team._id] ?? 0}
          caption={team.bookingDailyQuota ? `goal ${team.bookingDailyQuota} a business day` : "No goal"}
        />
        <Figure label="DM closers" value={team.activeDmClosers} caption="active" />
        <Figure
          label="Programs it can book"
          value={canBook}
          of={board.programs.length}
          caption={firstGap ? `${firstGap}: no link` : "Every program"}
          tone={firstGap ? "warning" : "default"}
        />
        <Figure label="Link copies · 7 days" value={activity.copies7d.teams[team._id] ?? 0} caption="from the DM portal" />
      </div>
    );
  }
  // Coverage, Event types and Link portal share concept C's figures.
  return (
    <div className="flex flex-wrap">
      <Figure
        label="Coverage"
        value={figures.covered}
        of={figures.cells}
        meter={figures.cells ? figures.covered / figures.cells : 0}
        href="/workspace/booking"
      />
      <Figure
        label="No link"
        value={figures.noLink}
        caption="cells"
        tone={figures.noLink ? "danger" : "default"}
        href="/workspace/booking?show=problems"
      />
      <Figure
        label="Broken"
        value={figures.broken}
        caption="cells"
        tone={figures.broken ? "danger" : "default"}
        href="/workspace/booking?show=problems"
      />
      <Figure label="Unsorted" value={figures.unsorted} caption="event types" href="/workspace/booking/inbox" />
    </div>
  );
}

function PortalStatus() {
  const portal = useQuery(api.linkPortal.configQueries.getPortalConfigForSettings, {});
  if (portal === undefined) return <div className="w-[170px]" aria-hidden />;
  const live = portal?.isEnabled === true;
  return (
    <div className="flex flex-col items-end gap-[5px] pl-1.5">
      <Link
        href="/workspace/booking/portal"
        className="inline-flex h-8 items-center gap-2 rounded-[7px] border border-board-foreground/15 bg-board-raised px-3 text-[13px] font-medium text-board-foreground outline-none hover:bg-board-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("size-1.5 rounded-full", live ? "bg-primary" : "bg-board-muted")} aria-hidden />
        {live ? "Portal is live" : portal ? "Portal is off" : "No portal yet"}
      </Link>
      <span className="text-[12px] whitespace-nowrap text-board-muted">
        {live ? "Changes reach DM closers right away" : "DM closers can’t copy links"}
      </span>
    </div>
  );
}

function TeamMeta({ team }: { team: Coverage["teams"][number] }) {
  return (
    <>
      utm_source <span className="font-mono text-board-foreground">{team.utmSource}</span>
      {" · "}
      {team.bookingDailyQuota ? `goal ${team.bookingDailyQuota} booked calls a business day` : "no daily goal"}
      {" · "}
      {team.activeDmClosers} active DM {team.activeDmClosers === 1 ? "closer" : "closers"}
    </>
  );
}

function TeamActions({ team }: { team: Coverage["teams"][number] }) {
  const [editing, setEditing] = useState(false);
  const setTeamActive = useMutation(api.attribution.teams.setTeamActive);
  const teams = useQuery(api.attribution.teams.listTeams, {});
  const doc = teams?.find((row) => row._id === team._id) ?? null;
  const boardButton =
    "border-board-foreground/15 bg-board-raised text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10";

  async function toggle() {
    try {
      await setTeamActive({ teamId: team._id, isActive: !team.isActive });
      toast.success(team.isActive ? `${team.displayName} disabled` : `${team.displayName} enabled`);
    } catch (error) {
      reportClientError(error, { flow: "booking_team_active" });
      toast.error(getErrorMessage(error, "Couldn’t change this team."));
    }
  }

  return (
    <div className="flex items-center gap-2 self-start pt-1">
      <Button variant="outline" size="sm" className={boardButton} onClick={() => setEditing(true)} disabled={!doc}>
        Edit team
      </Button>
      <Button variant="outline" size="sm" className={boardButton} onClick={() => void toggle()}>
        {team.isActive ? "Disable" : "Enable"}
      </Button>
      {doc ? <AttributionTeamDialog open={editing} onOpenChange={setEditing} team={doc} /> : null}
    </div>
  );
}

function useEnsureCoverage(migrated: boolean | undefined) {
  const ensureCoverage = useMutation(api.bookingSetup.mutations.ensureCoverage);
  const started = useRef(false);
  useEffect(() => {
    if (migrated !== false || started.current) return;
    started.current = true;
    const run = () => {
      ensureCoverage({}).catch((error: unknown) => {
        reportClientError(error, { flow: "booking_setup_ensure_coverage" });
        toast.error(getErrorMessage(error, "Couldn't move this workspace to the new booking layout."), {
          duration: Infinity,
          action: { label: "Try again", onClick: run },
        });
      });
    };
    run();
  }, [ensureCoverage, migrated]);
}
