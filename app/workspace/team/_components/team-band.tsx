"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ChevronLeftIcon } from "lucide-react";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { cn } from "@/lib/utils";
import { GoalsAction, GoalsFigures } from "./band/goals-figures";
import { MembersAction, MembersFigures } from "./band/members-figures";
import { ReviewAction, ReviewFigures, ReviewTabCount } from "./band/review-figures";
import { SchedulesAction, SchedulesFigures } from "./band/schedules-figures";
import { TeamActions, TeamFigures, TeamMeta, TeamsAction, TeamsFigures, TeamTitle } from "./band/teams-figures";

export type TeamSection = "members" | "review" | "teams" | "team" | "schedules" | "goals";
type TabSection = Exclude<TeamSection, "team">;

export function teamSectionFromPath(pathname: string): TeamSection {
  if (pathname.startsWith("/workspace/team/review")) return "review";
  if (pathname.startsWith("/workspace/team/teams/")) return "team";
  if (pathname.startsWith("/workspace/team/teams")) return "teams";
  if (pathname.startsWith("/workspace/team/schedules")) return "schedules";
  if (pathname.startsWith("/workspace/team/goals")) return "goals";
  return "members";
}

const TITLE: Record<TabSection, string> = {
  members: "Team",
  review: "Review",
  teams: "Teams",
  schedules: "Schedules",
  goals: "Goals",
};

// Two lines at most at the description's width, so the band keeps its height.
const DESCRIPTION: Record<TabSection, string> = {
  members: "Everyone who gets credit for a sale: what they do, their team, their weekly hours. Open someone to change any of it.",
  review: "Records that may be one human, Slack users linked to nobody, and teams that disagree. Decide each one.",
  teams: "One list of teams for lead gen and DM links. A team’s utm_source credits its DM closers’ bookings; its lead generators count for it on Lead Gen.",
  schedules: "Everyone’s week, by role. The reports divide each role’s results by these hours. Changes apply from today on.",
  goals: "Qualified leads a day for the whole workspace, and booked calls a day for each team. Goals count only the days someone works.",
};

const TABS: Array<{ section: TabSection; href: string; label: string }> = [
  { section: "members", href: "/workspace/team", label: "Members" },
  { section: "review", href: "/workspace/team/review", label: "Review" },
  { section: "teams", href: "/workspace/team/teams", label: "Teams" },
  { section: "schedules", href: "/workspace/team/schedules", label: "Schedules" },
  { section: "goals", href: "/workspace/team/goals", label: "Goals" },
];

function sectionTrail(section: TabSection) {
  const tab = TABS.find((candidate) => candidate.section === section);
  return [
    { label: "Home", href: "/workspace" },
    { label: "Team", href: "/workspace/team" },
    // Members shares Team's URL; the last crumb isn't a link, its href is only its key.
    ...(tab ? [{ label: tab.label, href: tab.section === "members" ? `${tab.href}#members` : tab.href }] : []),
  ];
}

// Each section's figures and lime action live in band/<section>-figures.tsx.
const FIGURES: Record<TabSection, ComponentType> = {
  members: MembersFigures,
  review: ReviewFigures,
  teams: TeamsFigures,
  schedules: SchedulesFigures,
  goals: GoalsFigures,
};

const ACTION: Record<TabSection, ComponentType> = {
  members: MembersAction,
  review: ReviewAction,
  teams: TeamsAction,
  schedules: SchedulesAction,
  goals: GoalsAction,
};

/**
 * The Team band, rendered once by the hub's layout so it stays mounted while
 * the tabs change: the section's title and description, its figures, its one
 * lime action, and the tab row. A team's page (/workspace/team/teams/<id>)
 * shows the team instead, under the Teams tab.
 */
export function TeamBand() {
  const pathname = usePathname();
  const params = useParams<{ teamId?: string }>();
  const section = teamSectionFromPath(pathname);
  const Figures = section === "team" ? null : FIGURES[section];
  const Action = section === "team" ? null : ACTION[section];
  // "Home › Team › Teams". A team's page sets its own trail (with the team's name).
  useBreadcrumbTrail(section === "team" ? null : sectionTrail(section));

  return (
    <header className="overflow-hidden rounded-xl bg-board text-board-foreground dark:ring-1 dark:ring-board-foreground/10">
      <div className="dark flex flex-col px-4 pt-3.5 @lg:px-[18px]">
        <div className="flex min-h-[78px] flex-wrap items-end gap-x-[18px] gap-y-3 pb-3">
          <div className="min-w-0 flex-[1_1_260px]">
            {section === "team" ? (
              <Link
                href="/workspace/team/teams"
                className="-ml-1 mb-1.5 inline-flex min-h-6 items-center gap-1 rounded-sm pr-1.5 text-[13px] font-medium text-board-muted outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeftIcon className="size-4" aria-hidden="true" />
                Teams
              </Link>
            ) : null}
            <h1 className="flex flex-wrap items-center gap-2.5 text-[26px] leading-[1.1] font-semibold tracking-[-0.01em]">
              {section === "team" ? <TeamTitle teamId={params.teamId} /> : TITLE[section]}
            </h1>
            {/* Three lines held on every tab, so the band doesn't jump between them. */}
            <p
              className={cn(
                "mt-[5px] max-w-[520px] text-[13px] leading-[19px] text-board-muted",
                section !== "team" && "min-h-[57px]",
              )}
            >
              {section === "team" ? <TeamMeta teamId={params.teamId} /> : DESCRIPTION[section]}
            </p>
            {section === "team" ? <TeamActions teamId={params.teamId} /> : null}
          </div>
          {/* Reserve the figures' width so a tab without figures folds like one with them. */}
          <div className="@3xl:min-w-[33rem] @3xl:self-start">
            {section === "team" ? <TeamFigures teamId={params.teamId} /> : Figures ? <Figures /> : null}
          </div>
          {Action ? (
            <div className="flex self-start">
              <Action />
            </div>
          ) : null}
        </div>
        <nav
          aria-label="Team sections"
          className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
        >
          {TABS.map((tab) => {
            const active = tab.section === section || (tab.section === "teams" && section === "team");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className="flex h-10 shrink-0 items-center gap-[7px] border-b-2 border-transparent font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap text-board-muted uppercase outline-none hover:text-board-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:border-primary aria-[current=page]:text-board-foreground"
              >
                {tab.label}
                {tab.section === "review" ? <ReviewTabCount /> : null}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
