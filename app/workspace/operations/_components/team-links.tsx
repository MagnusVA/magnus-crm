"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MemberCardFrom } from "@/app/workspace/team/_components/member-card/member-card-host";

// Report pages show figures that come from a schedule or a goal; the setting
// lives in Team. These links take a figure to the place where it's set
// (the URL contract in the Team hub brief). Every link explains itself on
// hover and focus, and shows a focus ring.

export type ScheduleRole = "lead_gen" | "slack" | "dm_closer";

export const teamHref = {
  members: (role?: ScheduleRole) => (role ? `/workspace/team?role=${role}` : "/workspace/team"),
  schedules: (role: ScheduleRole) => `/workspace/team/schedules?role=${role}`,
  teams: () => "/workspace/team/teams",
  team: (teamId: string) => `/workspace/team/teams/${encodeURIComponent(teamId)}`,
  goals: (anchor: "qualified" | "booked") => `/workspace/team/goals#${anchor}`,
  // A member card opened from a report links back to it (`&from=`). Each
  // defaults to the report that shows that role; pass null from elsewhere.
  worker: (workerId: string, from: MemberCardFrom | null = "lead-gen") =>
    `/workspace/team?worker=${encodeURIComponent(workerId)}&schedule=lead_gen${fromParam(from)}`,
  slackUser: (slackUserId: string, from: MemberCardFrom | null = "qualifications") =>
    `/workspace/team?slackUser=${encodeURIComponent(slackUserId)}&schedule=slack${fromParam(from)}`,
  dmCloser: (dmCloserId: string, from: MemberCardFrom | null = "booked-calls") =>
    `/workspace/team?dmCloser=${encodeURIComponent(dmCloserId)}&schedule=dm_closer${fromParam(from)}`,
} as const;

function fromParam(from: MemberCardFrom | null) {
  return from ? `&from=${from}` : "";
}

const hoursFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** "7", "7.5", "7.25": hours keep quarter hours. */
export function formatScheduleHours(hours: number) {
  return hoursFormat.format(hours);
}

const focusRing =
  "rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

/** A link with a tooltip that says where it goes and why. */
export function TipLink({
  href,
  tip,
  className,
  children,
  side = "top",
  "aria-label": ariaLabel,
}: {
  href: string;
  tip: ReactNode;
  className?: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  "aria-label"?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href={href} aria-label={ariaLabel} className={cn(focusRing, className)}>
          {children}
        </Link>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[17rem] text-[12.5px] leading-snug font-normal tracking-normal normal-case">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/** A caption on the navy band that links to where its figure is set. */
export function BandCaptionLink({ href, tip, children }: { href: string; tip: ReactNode; children: ReactNode }) {
  return (
    <TipLink
      href={href}
      tip={tip}
      className="underline decoration-board-foreground/40 decoration-dotted underline-offset-[3px] hover:text-board-foreground hover:decoration-board-foreground focus-visible:ring-offset-board"
    >
      {children}
    </TipLink>
  );
}

/**
 * One person's hours on a report row: "7 h scheduled" with a dotted
 * underline, or "No schedule · set it" in warning ink. Both open the
 * person's week in Team.
 */
export function ScheduleHoursLink({
  href,
  hours,
  name,
  unit = "scheduled",
  formatHours = formatScheduleHours,
}: {
  href: string;
  /** Scheduled hours; zero or null shows "No schedule · set it". */
  hours: number | null;
  name: string;
  unit?: string;
  formatHours?: (hours: number) => string;
}) {
  if (!hours) {
    return (
      <TipLink
        href={href}
        tip={`${name} has no hours scheduled, so their work counts but adds no hours. Set their week in Team.`}
        className="font-medium text-warning-ink underline decoration-current/50 underline-offset-[3px] hover:decoration-current"
      >
        No schedule · set it
      </TipLink>
    );
  }
  return (
    <TipLink
      href={href}
      tip={`Opens ${name}'s week in Team. Change it there; this page follows.`}
      className="underline decoration-current/40 decoration-dotted underline-offset-[3px] hover:text-foreground hover:decoration-current"
    >
      {formatHours(hours)} h {unit}
    </TipLink>
  );
}

/** "Team ↗" beside a team's group header: opens the team's page in Team. */
export function TeamPageLink({ teamId, teamName, className }: { teamId: string; teamName: string; className?: string }) {
  return (
    <TipLink
      href={teamHref.team(teamId)}
      tip={`Opens ${teamName} in Team › Teams: its DM closers, links and schedules.`}
      aria-label={`${teamName} team page`}
      className={cn(
        "inline-flex items-center gap-0.5 font-sans text-[12.5px] font-medium tracking-normal normal-case text-foreground/80 hover:text-foreground hover:underline",
        className,
      )}
    >
      Team
      <ArrowUpRightIcon aria-hidden="true" className="size-3" />
    </TipLink>
  );
}

/**
 * The dashed chip on a report's band where a config button used to be:
 * the old buttons struck through, then "moved to Team".
 */
export function MovedToTeamChip({
  href,
  moved,
  tip,
  className,
}: {
  href: string;
  /** The old button labels, struck through in order. */
  moved: string[];
  tip: ReactNode;
  className?: string;
}) {
  return (
    <TipLink
      href={href}
      tip={tip}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-board-foreground/35 px-2.5 text-[12.5px] whitespace-nowrap text-board-muted hover:border-board-foreground/70 hover:text-board-foreground focus-visible:ring-offset-board",
        className,
      )}
    >
      <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
      <span>
        {moved.map((label, index) => (
          <span key={label}>
            {index > 0 ? (index === moved.length - 1 ? " and " : ", ") : null}
            <s>{label}</s>
          </span>
        ))}{" "}
        moved to <b className="font-semibold text-board-foreground">Team</b>
      </span>
    </TipLink>
  );
}
