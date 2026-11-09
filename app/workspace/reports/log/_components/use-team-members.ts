"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type TeamMemberOption = { teamMemberId: Id<"teamMembers">; name: string; userId: Id<"users"> | null };

/**
 * The tenant's team members from the Team directory (admins only, as the
 * report pages are): the Log's member filter, and the map that lets a closer
 * named by their login open their member report.
 */
export function useTeamMembers() {
  const directory = useQuery(api.team.directory.getDirectory, {});
  return useMemo(() => {
    if (directory === undefined) return undefined;
    const members: TeamMemberOption[] = [];
    const byUserId = new Map<Id<"users">, Id<"teamMembers">>();
    for (const member of directory.members) {
      if (member.teamMemberId === null) continue;
      members.push({ teamMemberId: member.teamMemberId, name: member.name, userId: member.login?.userId ?? null });
      if (member.login) byUserId.set(member.login.userId, member.teamMemberId);
    }
    return { members, byUserId };
  }, [directory]);
}

/** A team member's report. */
export function memberReportHref(teamMemberId: Id<"teamMembers"> | string) {
  return `/workspace/reports/people/${teamMemberId}`;
}
