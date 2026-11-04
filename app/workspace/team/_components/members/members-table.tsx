"use client";

import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatHours, WeekStrip } from "../schedule-editor";
import { FIGURE, HelpTip, initials, LABEL } from "../team-ui";
import {
  hasLeadGen,
  loginLine,
  memberStatus,
  roleChips,
  roleWeeks,
  teamLines,
  type DirectoryMember,
  type MemberStatus,
  type RoleWeek,
} from "./members-model";

/**
 * h-01's members grid. The page root is the container: from @3xl every column
 * shows; from @5xl each week shows as a strip; narrower, ROLES go under the
 * name and TEAM and HOURS fold away (the member card has them).
 */
const GRID =
  "grid items-center gap-x-3 px-4 grid-cols-[28px_minmax(0,1fr)_72px] @3xl:grid-cols-[28px_minmax(150px,1.4fr)_minmax(140px,1.15fr)_minmax(120px,1fr)_150px_76px] @5xl:grid-cols-[28px_minmax(170px,1.4fr)_minmax(150px,1.2fr)_minmax(130px,1fr)_300px_84px]";

export function MembersTableHead() {
  return (
    <div className={cn(GRID, "min-h-8 border-b border-border pt-2.5 pb-[7px]")}>
      <span aria-hidden />
      <span className={LABEL}>
        <HelpTip tip="One human. The line under the name is their CRM login, or what they are without one.">
          Team member
        </HelpTip>
      </span>
      <span className={cn(LABEL, "hidden @3xl:block")}>
        <HelpTip tip="The jobs that get them credit: phone closer (takes the sales calls), lead gen (captures prospects), Slack (posts qualified leads), DM closer (sends booking links). Owner and Admin run the CRM. A struck-through role is inactive.">
          Roles
        </HelpTip>
      </span>
      <span className={cn(LABEL, "hidden @3xl:block")}>
        <HelpTip tip="The teams their roles count for: lead gen counts their captures for a team, and a DM closer’s links credit theirs. Slack qualifiers have no team.">
          Team
        </HelpTip>
      </span>
      <span className={cn(LABEL, "hidden @3xl:block")}>
        <HelpTip tip="Each role’s own week, in force today. Lead Gen, Qualifications and Booked Calls divide that role’s results by its hours. Owners, admins and phone closers have no per-hour report.">
          Hours
        </HelpTip>
      </span>
      <span className={LABEL}>
        <HelpTip tip="Active while any of their records is active. Invited: the CRM login isn’t accepted yet. Removed: the login was removed and nothing else is active. Inactive: every record is switched off; history stays.">
          Status
        </HelpTip>
      </span>
    </div>
  );
}

export function MemberRow({
  member,
  teamName,
  href,
}: {
  member: DirectoryMember;
  teamName: (teamId: string) => string;
  /** Opens this member's card on the page (`?member=<key>`). */
  href: string;
}) {
  const status = memberStatus(member);
  const dim = status === "Inactive" || status === "Removed";
  const chips = roleChips(member);

  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        href={href}
        scroll={false}
        prefetch={false}
        className={cn(
          GRID,
          "min-h-[54px] py-[7px] outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        <MemberAvatar member={member} />
        <span className={cn("flex min-w-0 flex-col", dim && "opacity-60")}>
          <span className="truncate text-[14.5px] font-semibold">{member.name}</span>
          <small className="truncate text-[13px] text-muted-foreground">{loginLine(member)}</small>
          <RoleChips chips={chips} className="mt-1 @3xl:hidden" />
        </span>
        <RoleChips chips={chips} className="hidden @3xl:flex" />
        <span className="hidden min-w-0 @3xl:block">
          <TeamCell member={member} teamName={teamName} />
        </span>
        <span className="hidden min-w-0 @3xl:block">
          <HoursCell member={member} teamName={teamName} />
        </span>
        <StatusWord status={status} />
      </Link>
    </li>
  );
}

function MemberAvatar({ member }: { member: DirectoryMember }) {
  const picture = member.login?.profilePictureUrl;
  return (
    <Avatar className="size-7" aria-hidden>
      {picture ? <AvatarImage src={picture} alt="" /> : null}
      <AvatarFallback
        className={cn(
          "font-condensed text-[11px] font-bold tracking-[0.06em] text-muted-foreground",
          // No CRM login: an outlined avatar, as in h-01.
          member.login ? "bg-muted" : "bg-card",
        )}
      >
        {initials(member.name)}
      </AvatarFallback>
    </Avatar>
  );
}

function RoleChips({ chips, className }: { chips: ReturnType<typeof roleChips>; className?: string }) {
  if (chips.length === 0) return <span className={cn("text-[13px] text-muted-foreground", className)}>—</span>;
  return (
    <span className={cn("flex min-w-0 flex-wrap gap-1", className)}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.off ? `${chip.label}: inactive` : undefined}
          className={cn(
            "inline-flex h-5 items-center rounded-[4px] px-1.5 font-condensed text-[11px] leading-none font-bold tracking-[0.1em] whitespace-nowrap uppercase",
            chip.off
              ? "text-muted-foreground line-through decoration-muted-foreground/50 ring-1 ring-border ring-inset"
              : "bg-muted text-foreground",
          )}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}

function TeamCell({ member, teamName }: { member: DirectoryMember; teamName: (teamId: string) => string }) {
  const lines = teamLines(member, teamName);
  if (lines.length === 0) {
    return (
      <span className="flex flex-col text-[14px]">
        <span className="text-muted-foreground">—</span>
        <small className="text-[12.5px] text-muted-foreground">No team role</small>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {lines.map((line) => (
        <span key={line.teamId ?? "none"} className="flex min-w-0 flex-col text-[14px] leading-tight">
          <span className={cn("truncate", !line.teamId && "text-muted-foreground")}>{line.name}</span>
          <small className="truncate text-[12.5px] text-muted-foreground">{line.via}</small>
        </span>
      ))}
    </span>
  );
}

function HoursCell({ member, teamName }: { member: DirectoryMember; teamName: (teamId: string) => string }) {
  const weeks = roleWeeks(member, teamName);
  if (weeks.length === 0) {
    return (
      <span className="text-[12.5px] text-muted-foreground">
        {hasLeadGen(member) ? "Lead gen · No schedule" : "No per-hour report"}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      {weeks.map((week) => (
        <WeekLine key={week.key} week={week} />
      ))}
    </span>
  );
}

/** One role's week: its label, the strip (from @5xl), and its total, or "No schedule". */
function WeekLine({ week }: { week: RoleWeek }) {
  const scheduled = week.total > 0;
  return (
    <span className={cn("flex min-h-[26px] items-center gap-2", !week.active && "opacity-60")}>
      <span className="w-[72px] shrink-0 truncate text-[12.5px] text-muted-foreground" title={week.label}>
        {week.label}
      </span>
      {scheduled ? (
        <>
          <WeekStrip
            week={week.week}
            className="hidden gap-[2px] @5xl:inline-flex [&>span]:h-[26px] [&>span]:w-[23px] [&>span>span:first-child]:text-[8.5px]"
          />
          <span className={cn(FIGURE, "min-w-[38px] text-right")}>
            {formatHours(week.total)}
            <small className="ml-px text-[12px] font-semibold text-muted-foreground">h</small>
          </span>
        </>
      ) : (
        <span className="text-[13px] text-muted-foreground">No schedule</span>
      )}
    </span>
  );
}

const STATUS_CLASS: Record<MemberStatus, string> = {
  Active: "text-stage-follow-up-ink",
  Invited: "text-muted-foreground",
  Inactive: "text-muted-foreground",
  Removed: "text-muted-foreground",
};

function StatusWord({ status }: { status: MemberStatus }) {
  return (
    <span
      className={cn(
        "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        STATUS_CLASS[status],
      )}
    >
      {status}
    </span>
  );
}
