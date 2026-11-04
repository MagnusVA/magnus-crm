"use client";

import { useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import posthog from "posthog-js";
import { format } from "date-fns";
import { DownloadIcon, SearchIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { usePageTitle } from "@/hooks/use-page-title";
import { downloadCSV } from "@/lib/export-csv";
import { cn } from "@/lib/utils";
import { useMemberCardHref } from "../member-card/member-card-host";
import { RecentReassignments } from "../recent-reassignments";
import { CARD } from "../team-ui";
import { TeamSectionSkeleton } from "../team-section-skeleton";
import {
  byName,
  CSV_HEADERS,
  csvRow,
  matchesRole,
  matchesSearch,
  matchesTeam,
  parseRoleFilter,
  ROLE_FILTERS,
  type Directory,
  type RoleFilter,
} from "./members-model";
import { MemberRow, MembersTableHead } from "./members-table";

/**
 * Team › Members: one row per human who gets credit, whatever they do. The
 * filters live in the URL (`?q=`, `?role=`, `?team=<teamId>|none`), written in
 * place so a change never navigates. A row opens the member card
 * (`?member=<key>`), which the page's <MemberCardHost /> renders.
 */
export function MembersPageClient() {
  usePageTitle("Team");
  const directory = useQuery(api.team.directory.getDirectory, {});
  if (directory === undefined) return <TeamSectionSkeleton label="Loading team members" />;
  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      <MembersCard directory={directory} />
      <RecentReassignments />
    </div>
  );
}

function MembersCard({ directory }: { directory: Directory }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const cardHref = useMemberCardHref();
  // The search box keeps its own state so typing never waits on the URL.
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const role = parseRoleFilter(searchParams.get("role"));
  const teamParam = searchParams.get("team");

  const teamNames = useMemo(() => new Map(directory.teams.map((team) => [team.teamId as string, team.name])), [directory]);
  const team = teamParam === "none" || (teamParam && teamNames.has(teamParam)) ? teamParam : null;
  const teamName = (teamId: string) => teamNames.get(teamId) ?? "Unknown team";

  function writeParam(key: string, value: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(key, value);
    else params.delete(key);
    const search = params.toString();
    window.history.replaceState(null, "", search ? `${pathname}?${search}` : pathname);
  }

  const members = directory.members;
  // Role counts follow the search and the team, so each chip says what it would show.
  const scoped = members.filter((member) => matchesSearch(member, query) && matchesTeam(member, team));
  const counts = Object.fromEntries(
    ROLE_FILTERS.map((filter) => [filter.value, scoped.filter((member) => matchesRole(member, filter.value)).length]),
  ) as Record<RoleFilter, number>;
  const shown = scoped.filter((member) => !role || matchesRole(member, role)).sort(byName);
  const filtered = Boolean(query.trim() || role || team);

  const teamOptions = [...directory.teams]
    .filter((option) => option.isActive || option.teamId === team)
    .sort((left, right) => left.name.localeCompare(right.name));

  function clearFilters() {
    setQuery("");
    const params = new URLSearchParams(window.location.search);
    for (const key of ["q", "role", "team"]) params.delete(key);
    const search = params.toString();
    window.history.replaceState(null, "", search ? `${pathname}?${search}` : pathname);
  }

  function exportCsv() {
    downloadCSV(`team-members-${format(new Date(), "yyyy-MM-dd")}`, CSV_HEADERS, shown.map((member) => csvRow(member, teamName)));
    posthog.capture("team_members_exported", { rows: shown.length, filtered });
  }

  return (
    <section className={CARD} aria-labelledby="members-title">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border px-4 py-2.5">
        <h2 id="members-title" className="text-[15px] font-semibold">
          Members
        </h2>
        <span className="text-[13px] text-muted-foreground">One row per human, whatever they do</span>
        <div className="flex w-full flex-wrap items-center gap-2 @5xl:ml-auto @5xl:w-auto @5xl:justify-end">
          <label className="relative flex items-center">
            <span className="sr-only">Find a team member</span>
            <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                writeParam("q", event.target.value.trim() ? event.target.value : null);
              }}
              placeholder="Find someone"
              className="h-[30px] w-[200px] pl-8 text-[13px]"
            />
          </label>
          <RoleSegments role={role} counts={counts} total={scoped.length} onChange={(next) => writeParam("role", next)} />
          <NativeSelect
            aria-label="Team"
            value={team ?? ""}
            onChange={(event) => writeParam("team", event.target.value || null)}
            className="[&_select]:h-[30px] [&_select]:text-[13px]"
          >
            <NativeSelectOption value="">All teams</NativeSelectOption>
            {teamOptions.map((option) => (
              <NativeSelectOption key={option.teamId} value={option.teamId}>
                {option.isActive ? option.name : `${option.name} (archived)`}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="none">No team</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>

      {directory.capped ? (
        <p role="status" className="border-b border-border bg-muted/40 px-4 py-2 text-[13px] text-muted-foreground">
          This workspace has more records than the list reads at once, so some team members or their weeks may be
          missing here.
        </p>
      ) : null}

      <MembersTableHead />
      {shown.length > 0 ? (
        <ul>
          {shown.map((member) => (
            <MemberRow key={member.key} member={member} teamName={teamName} href={cardHref(member.key)} />
          ))}
        </ul>
      ) : (
        <p className="flex min-h-14 flex-wrap items-center gap-x-1.5 px-4 py-3 text-[14px] text-muted-foreground">
          {members.length === 0 ? (
            "Nobody yet. Invite someone to the CRM, or add DM closers on a team’s page."
          ) : (
            <>
              <span>{emptyLine(query, role, team, teamName)}</span>
              <Button variant="link" size="xs" className="h-6 px-0 text-[14px]" onClick={clearFilters}>
                Clear filters
              </Button>
            </>
          )}
        </p>
      )}

      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-1.5 text-[13px] text-muted-foreground">
        <span className="tabular-nums">
          {filtered ? `${shown.length} of ${members.length} team members` : `${members.length} team members`}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={exportCsv}
          disabled={shown.length === 0}
        >
          <DownloadIcon data-icon="inline-start" />
          Export CSV
        </Button>
      </div>
    </section>
  );
}

function emptyLine(query: string, role: RoleFilter | null, team: string | null, teamName: (teamId: string) => string) {
  const parts = [
    role ? `in ${ROLE_FILTERS.find((filter) => filter.value === role)?.label}` : null,
    team === "none" ? "with no team" : team ? `on ${teamName(team)}` : null,
  ].filter(Boolean);
  const who = query.trim() ? `Nobody matches “${query.trim()}”` : "Nobody";
  return `${who}${parts.length ? ` ${parts.join(" ")}` : ""}.`;
}

/** h-01's role filter: All, then each role with its count. Pressing the chosen one again goes back to All. */
function RoleSegments({
  role,
  counts,
  total,
  onChange,
}: {
  role: RoleFilter | null;
  counts: Record<RoleFilter, number>;
  total: number;
  onChange: (role: RoleFilter | null) => void;
}) {
  const options: Array<{ value: RoleFilter | null; label: string; count: number }> = [
    { value: null, label: "All", count: total },
    ...ROLE_FILTERS.map((filter) => ({ ...filter, count: counts[filter.value] })),
  ];
  return (
    <div role="group" aria-label="Role" className="inline-flex flex-wrap gap-0.5 rounded-[7px] bg-muted p-[3px]">
      {options.map((option) => {
        const on = option.value === role;
        return (
          <button
            key={option.value ?? "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? null : option.value)}
            className={cn(
              "inline-flex h-6 items-center gap-[5px] rounded-[5px] px-[9px] text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              on && "bg-card text-foreground shadow-[0_1px_2px_rgb(20_26_40/0.12)]",
            )}
          >
            {option.label}
            <span className="font-condensed text-[12px] leading-none font-semibold text-muted-foreground tabular-nums">
              {option.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
