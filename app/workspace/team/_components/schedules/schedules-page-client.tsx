"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Switch } from "@/components/ui/switch";
import { usePageTitle } from "@/hooks/use-page-title";
import { cn } from "@/lib/utils";
import { TeamSectionSkeleton } from "../team-section-skeleton";
import { CARD, CardHead } from "../team-ui";
import {
  parseRoleFilter,
  ROLE_FILTERS,
  scheduleGroups,
  scheduleRows,
  type RoleFilter,
  type ScheduleRow,
} from "./schedule-model";
import { SchedulesGrid } from "./schedules-grid";

const TOTAL_LABEL: Record<RoleFilter, string> = {
  all: "Everyone",
  lead_gen: "Lead gen",
  slack: "Slack qualifiers",
  dm_closer: "DM closers",
};

const ROLE_NOTE: Record<RoleFilter, string> = {
  all: "Each role keeps its own week: someone who generates leads and closes DMs has two rows. Lead Gen, Qualifications and Booked Calls each divide by their role’s hours.",
  lead_gen: "What Lead Gen divides captures by (per scheduled hour), grouped by each worker’s team.",
  slack:
    "What Qualifications divides qualified leads by. Slack qualifiers have no team, so they form one group, and the qualified-leads goal counts the days any of them works.",
  dm_closer:
    "What Booked Calls divides bookings by, grouped by the team the closer’s links credit. A team’s booked-calls goal counts only the days one of its closers works.",
};

/**
 * Team › Schedules: every role record's week in force today, grouped by role
 * and team, with the days nobody in a group works. `?role=` filters by role,
 * `?show=missing` keeps only the records with no schedule, and
 * `?inactive=1` shows inactive records too. A row opens the member's card at
 * that role's week.
 */
export function SchedulesPageClient() {
  usePageTitle("Schedules");
  const directory = useQuery(api.team.directory.getDirectory, {});
  const searchParams = useSearchParams();
  const role = parseRoleFilter(searchParams.get("role"));
  const missingOnly = searchParams.get("show") === "missing";
  const showInactive = searchParams.get("inactive") === "1";

  const rows = useMemo(() => (directory ? scheduleRows(directory) : []), [directory]);
  const visible = rows.filter(
    (row) => (showInactive || row.active) && (!missingOnly || (row.active && !row.scheduled)),
  );
  const counts = countByRole(rows.filter((row) => showInactive || row.active));
  const shown = role === "all" ? visible : visible.filter((row) => row.role === role);
  // A few hundred rows at most: cheap enough to group on every render.
  const groups = directory ? scheduleGroups(shown, directory.teams) : [];
  const inactiveCount = rows.filter((row) => !row.active && (role === "all" || row.role === role)).length;

  if (!directory) return <TeamSectionSkeleton label="Loading schedules" />;

  return (
    <section className={CARD} aria-labelledby="schedules-title">
      <CardHead
        title={<span id="schedules-title">Weeks</span>}
        meta={missingOnly ? "No schedule only" : "Hours a weekday, in force today"}
      >
        <RoleTabs role={role} counts={counts} />
      </CardHead>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <p className="min-w-0 flex-[1_1_360px] text-[13px] text-muted-foreground">{ROLE_NOTE[role]}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {missingOnly ? (
            <ParamLink set={{ show: null }} className="text-[13px]">
              Show every week
            </ParamLink>
          ) : null}
          <InactiveToggle checked={showInactive} count={inactiveCount} />
        </div>
      </div>
      {directory.capped ? (
        <p className="border-b border-border bg-warning-surface px-4 py-2 text-[13px] text-warning-ink">
          This workspace has more records than the page reads at once, so some weeks may be missing.
        </p>
      ) : null}
      {groups.length ? (
        <SchedulesGrid groups={groups} showRole={role === "all"} totalLabel={TOTAL_LABEL[role]} />
      ) : (
        <EmptyState role={role} missingOnly={missingOnly} />
      )}
      <p className="px-4 py-3 text-[13px] text-muted-foreground">
        Changes apply from today on. Earlier days keep the hours they had, so past per-hour figures don’t move.
      </p>
    </section>
  );
}

function countByRole(rows: readonly ScheduleRow[]) {
  const counts: Record<RoleFilter, number> = { all: rows.length, lead_gen: 0, slack: 0, dm_closer: 0 };
  for (const row of rows) counts[row.role] += 1;
  return counts;
}

/** A link that changes some of this page's URL params and keeps the rest. */
function ParamLink({
  set,
  className,
  children,
  ...rest
}: {
  set: Record<string, string | null>;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Link>, "href">) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  for (const [key, value] of Object.entries(set)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return (
    <Link
      href={query ? `${pathname}?${query}` : pathname}
      scroll={false}
      className={cn(
        "rounded-sm text-muted-foreground underline decoration-current/40 underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

function RoleTabs({ role, counts }: { role: RoleFilter; counts: Record<RoleFilter, number> }) {
  return (
    <nav aria-label="Role" className="flex flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {ROLE_FILTERS.map((filter) => (
        <ParamLink
          key={filter.role}
          set={{ role: filter.role === "all" ? null : filter.role }}
          aria-current={filter.role === role ? "page" : undefined}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_0_0_1px_var(--color-border)]"
        >
          {filter.label}
          <span className="font-condensed text-[12.5px] font-semibold text-muted-foreground tabular-nums">
            {counts[filter.role]}
          </span>
        </ParamLink>
      ))}
    </nav>
  );
}

function InactiveToggle({ checked, count }: { checked: boolean; count: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          const params = new URLSearchParams(searchParams.toString());
          if (next) params.set("inactive", "1");
          else params.delete("inactive");
          const query = params.toString();
          router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        }}
      />
      Show inactive
      <span className="font-condensed text-[12.5px] font-semibold tabular-nums">{count}</span>
    </label>
  );
}

function EmptyState({ role, missingOnly }: { role: RoleFilter; missingOnly: boolean }) {
  const words =
    role === "all" ? "Nobody here yet" : `No ${role === "slack" ? "Slack qualifiers" : TOTAL_LABEL[role].toLowerCase()} yet`;
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[14px] font-medium">{missingOnly ? "Every active role has a schedule." : `${words}.`}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {missingOnly ? (
          <ParamLink set={{ show: null }}>Show every week</ParamLink>
        ) : role === "dm_closer" ? (
          "Add DM closers on a team’s page in Teams; their weeks show here."
        ) : role === "slack" ? (
          "Slack users who qualify leads show here once Slack syncs them."
        ) : (
          <>
            Add people in <Link href="/workspace/team" className="underline underline-offset-2">Members</Link>; their
            weeks show here.
          </>
        )}
      </p>
    </div>
  );
}
