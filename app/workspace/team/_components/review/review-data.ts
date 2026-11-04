"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Directory, DirectoryMember, ReviewItem } from "@/convex/team/contracts";

// Team › Review: the open items and the directory they name, read together.

export type SameHumanItem = Extract<ReviewItem, { kind: "same_human" }>;
export type SlackUnlinkedItem = Extract<ReviewItem, { kind: "slack_unlinked" }>;
export type TeamsDisagreeItem = Extract<ReviewItem, { kind: "teams_disagree" }>;
export type TeamId = Id<"attributionTeams">;
export type MemberId = Id<"teamMembers">;
export type DirectoryTeam = Directory["teams"][number];

export type ReviewCounts = { sameHuman: number; slackOnly: number; teamsDisagree: number; total: number };

/** How many of each kind are open. */
export function reviewCounts(items: readonly ReviewItem[]): ReviewCounts {
  let sameHuman = 0;
  let slackOnly = 0;
  let teamsDisagree = 0;
  for (const item of items) {
    if (item.kind === "same_human") sameHuman++;
    else if (item.kind === "slack_unlinked") slackOnly++;
    else teamsDisagree++;
  }
  return { sameHuman, slackOnly, teamsDisagree, total: items.length };
}

export type ReviewData = {
  sameHuman: SameHumanItem[];
  slackUnlinked: SlackUnlinkedItem[];
  teamsDisagree: TeamsDisagreeItem[];
  count: number;
  directory: Directory;
  member: (id: MemberId) => DirectoryMember | undefined;
  /** A team member with no records left: the directory doesn't list it, Review still can. */
  isEmpty: (id: MemberId) => boolean;
  team: (id: TeamId | null) => DirectoryTeam | undefined;
  teamName: (id: TeamId | null) => string;
};

/**
 * The open review items and the directory, or undefined while either loads.
 * The directory leaves out team members with no records; a "Same human?"
 * item can still name one (a record moved away and left it empty), so it
 * stands in under the other's name, empty, and joining removes it. Other
 * items whose member the directory doesn't show (a write in flight) wait
 * until both queries agree.
 */
export function useReviewData(): ReviewData | undefined {
  const review = useQuery(api.team.review.listReviewItems, {});
  const directory = useQuery(api.team.directory.getDirectory, {});
  return useMemo(() => {
    if (!review || !directory) return undefined;
    const members = new Map<string, DirectoryMember>();
    for (const row of directory.members) if (row.teamMemberId) members.set(row.teamMemberId, row);
    const teams = new Map(directory.teams.map((row) => [row.teamId as string, row]));
    const empty = new Set<string>();
    for (const item of review.items) {
      if (item.kind !== "same_human") continue;
      const missing = item.members.filter((id) => !members.has(id));
      const present = item.members.find((id) => members.has(id));
      if (missing.length !== 1 || !present) continue;
      const id = missing[0];
      members.set(id, { key: id, teamMemberId: id, name: members.get(present)!.name, login: null, leadGen: [], slack: [], dmClosers: [] });
      empty.add(id);
    }
    const member = (id: MemberId) => members.get(id);
    const isEmpty = (id: MemberId) => empty.has(id);
    const team = (id: TeamId | null) => (id ? teams.get(id) : undefined);
    const teamName = (id: TeamId | null) => (id ? (teams.get(id)?.name ?? "A removed team") : "No team");
    const sameHuman: SameHumanItem[] = [];
    const slackUnlinked: SlackUnlinkedItem[] = [];
    const teamsDisagree: TeamsDisagreeItem[] = [];
    for (const item of review.items) {
      if (item.kind === "same_human") {
        if (item.members.every((id) => members.has(id))) sameHuman.push(item);
      } else if (item.kind === "slack_unlinked") {
        if (members.has(item.teamMemberId)) slackUnlinked.push(item);
      } else if (members.has(item.teamMemberId)) {
        teamsDisagree.push(item);
      }
    }
    return { sameHuman, slackUnlinked, teamsDisagree, count: review.count, directory, member, isEmpty, team, teamName };
  }, [review, directory]);
}

const LOGIN_ROLE: Record<NonNullable<DirectoryMember["login"]>["role"], string> = {
  tenant_master: "Owner",
  tenant_admin: "Admin",
  closer: "Phone closer",
  lead_generator: "Lead generator",
};

/** Does anything about this member still work today? */
export function memberActive(member: DirectoryMember) {
  return (
    (member.login !== null && member.login.isActive && !member.login.removed) ||
    member.leadGen.some((row) => row.isActive) ||
    member.slack.some((row) => !row.isDeleted) ||
    member.dmClosers.some((row) => row.isActive)
  );
}

/** "Admin", "Lead gen", "Slack @kendany", "DM closer": what this member does. */
export function memberRoles(member: DirectoryMember) {
  const roles: string[] = [];
  if (member.login) roles.push(`${LOGIN_ROLE[member.login.role]} login`);
  if (member.leadGen.length) roles.push("Lead gen");
  for (const row of member.slack) roles.push(row.handle ? `Slack @${row.handle}` : "Slack");
  if (member.dmClosers.length) roles.push("DM closer");
  return roles;
}

/** The teams this member's lead gen workers and DM closers are on, by name. */
export function memberTeamNames(member: DirectoryMember, teamName: (id: TeamId | null) => string) {
  const ids = new Set<TeamId>();
  for (const row of member.leadGen) if (row.teamId) ids.add(row.teamId);
  for (const row of member.dmClosers) ids.add(row.teamId);
  return [...ids].map(teamName);
}

/** Lowercased emails on the member's login and lead gen workers. */
export function memberEmails(member: DirectoryMember) {
  const emails = new Set<string>();
  if (member.login?.email) emails.add(member.login.email.trim().toLowerCase());
  for (const row of member.leadGen) if (row.email) emails.add(row.email.trim().toLowerCase());
  return emails;
}

/** "a removed login, a lead gen worker and a Slack user": what joining moves. */
export function recordsList(member: DirectoryMember) {
  const parts: string[] = [];
  if (member.login) parts.push(member.login.removed ? "a removed login" : "a CRM login");
  if (member.leadGen.length) parts.push(member.leadGen.length === 1 ? "a lead gen worker" : `${member.leadGen.length} lead gen workers`);
  if (member.slack.length) parts.push(member.slack.length === 1 ? "a Slack user" : `${member.slack.length} Slack users`);
  if (member.dmClosers.length) parts.push(member.dmClosers.length === 1 ? "a DM closer" : `${member.dmClosers.length} DM closers`);
  return parts;
}

/** ["a", "b", "c"] -> "a, b and c". */
export function joinWords(words: readonly string[]) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
