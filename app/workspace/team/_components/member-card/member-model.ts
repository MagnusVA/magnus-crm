import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MemberCardFrom, ScheduleRole } from "./member-card-host";

// Plain helpers behind the member card: who a directory member is, what
// their header says, and which records anchor them when their key changes.

export type Directory = FunctionReturnType<typeof api.team.directory.getDirectory>;
export type DirectoryMember = Directory["members"][number];
export type DirectoryTeam = Directory["teams"][number];
export type ReviewItem = FunctionReturnType<typeof api.team.review.listReviewItems>["items"][number];
export type TeamsDisagreeItem = Extract<ReviewItem, { kind: "teams_disagree" }>;
export type LoginRole = NonNullable<DirectoryMember["login"]>["role"];

export const LOGIN_ROLE_LABEL: Record<LoginRole, string> = {
  tenant_master: "Owner",
  tenant_admin: "Admin",
  closer: "Phone closer",
  lead_generator: "Lead generator",
};

/** The reports a card can be opened from, and the way back. */
export const FROM_REPORT: Record<MemberCardFrom, { label: string; href: string }> = {
  "lead-gen": { label: "Lead Gen", href: "/workspace/operations/lead-gen" },
  qualifications: { label: "Qualifications", href: "/workspace/operations/qualifications" },
  "booked-calls": { label: "Booked Calls", href: "/workspace/operations/booked-calls" },
};

export function isFrom(value: string | null): value is MemberCardFrom {
  return value === "lead-gen" || value === "qualifications" || value === "booked-calls";
}

export function isScheduleRole(value: string | null): value is ScheduleRole {
  return value === "lead_gen" || value === "slack" || value === "dm_closer";
}

/** Each role record's id as one string: what the card follows across a key change. */
export function recordKeys(member: DirectoryMember): string[] {
  return [
    ...(member.login ? [`user:${member.login.userId}`] : []),
    ...member.leadGen.map((row) => `worker:${row.workerId}`),
    ...member.slack.map((row) => `slack:${row.slackUserId}`),
    ...member.dmClosers.map((row) => `dm:${row.dmCloserId}`),
  ];
}

/**
 * After a join or a link changed keys, the member now holding the records the
 * card was showing: the login first, then the most records in common.
 */
export function followRecords(members: readonly DirectoryMember[], anchors: readonly string[]) {
  if (anchors.length === 0) return null;
  const wanted = new Set(anchors);
  const login = anchors.find((anchor) => anchor.startsWith("user:"));
  let best: DirectoryMember | null = null;
  let bestScore = 0;
  for (const member of members) {
    const keys = recordKeys(member);
    let score = keys.filter((key) => wanted.has(key)).length;
    if (login && keys.includes(login)) score += 100;
    if (score > bestScore) {
      best = member;
      bestScore = score;
    }
  }
  return best;
}

/** The member an alias names: `?worker=`, `?slackUser=` (Slack's id) or `?dmCloser=`. */
export function findByAlias(
  members: readonly DirectoryMember[],
  alias: { kind: "worker" | "slackUser" | "dmCloser"; id: string },
) {
  for (const member of members) {
    if (alias.kind === "worker" && member.leadGen.some((row) => row.workerId === alias.id)) return member;
    if (alias.kind === "slackUser" && member.slack.some((row) => row.slackUserId === alias.id)) return member;
    if (alias.kind === "dmCloser" && member.dmClosers.some((row) => row.dmCloserId === alias.id)) return member;
  }
  return null;
}

/** "Lead gen · Slack qualifier · DM closer", in that order; the login's role leads. */
export function roleWords(member: DirectoryMember) {
  const words: string[] = [];
  if (member.login && member.login.role !== "lead_generator") words.push(LOGIN_ROLE_LABEL[member.login.role]);
  if (member.leadGen.length || member.login?.role === "lead_generator") words.push("Lead gen");
  if (member.slack.length) words.push("Slack qualifier");
  if (member.dmClosers.length) words.push(member.dmClosers.length > 1 ? `DM closer ×${member.dmClosers.length}` : "DM closer");
  return words;
}

/** The distinct teams across the member's lead gen and DM closer records. */
export function memberTeams(member: DirectoryMember, teams: readonly DirectoryTeam[]) {
  const ids = new Set<string>();
  for (const row of member.leadGen) if (row.teamId) ids.add(row.teamId);
  for (const row of member.dmClosers) ids.add(row.teamId);
  return teams.filter((team) => ids.has(team.teamId));
}

export function teamName(teams: readonly DirectoryTeam[], teamId: Id<"attributionTeams"> | null) {
  if (!teamId) return "No team";
  return teams.find((team) => team.teamId === teamId)?.name ?? "A deleted team";
}

/**
 * The header's status word. A login speaks for the member; without one, the
 * member is active while any of their role records is.
 */
export function memberStatus(member: DirectoryMember): { word: string; tone: "active" | "muted" | "warning"; note: string } {
  const login = member.login;
  if (login) {
    if (login.removed) return { word: "Deactivated", tone: "muted", note: "can’t sign in" };
    if (login.invitationPending) return { word: "Invited", tone: "warning", note: "hasn’t signed up yet" };
    return { word: "Active", tone: "active", note: "can sign in" };
  }
  const active =
    member.leadGen.some((row) => row.isActive) ||
    member.dmClosers.some((row) => row.isActive) ||
    member.slack.some((row) => !row.isDeleted);
  return active
    ? { word: "Active", tone: "active", note: "no CRM login" }
    : { word: "Inactive", tone: "muted", note: "no active records" };
}

/** Which report divides each role's results by its hours, and which goal counts its days. */
export const WHERE_HOURS_COUNT: Record<
  ScheduleRole,
  { report: string; href: string; divides: string; goal: { label: string; href: string; line: string } | null }
> = {
  lead_gen: {
    report: "Lead Gen",
    href: "/workspace/operations/lead-gen",
    divides: "divides captures by these hours (captures per hour)",
    goal: null,
  },
  slack: {
    report: "Qualifications",
    href: "/workspace/operations/qualifications",
    divides: "divides qualified leads by these hours (qualified per hour)",
    goal: {
      label: "qualified leads goal",
      href: "/workspace/team/goals#qualified",
      line: "counts only the days Slack qualifiers work",
    },
  },
  dm_closer: {
    report: "Booked Calls",
    href: "/workspace/operations/booked-calls",
    divides: "divides booked calls by these hours (booked per hour)",
    goal: {
      label: "team’s booked calls goal",
      href: "/workspace/team/goals#booked",
      line: "counts only the days its DM closers work",
    },
  },
};

/** "Ana Alonzo" -> { firstName: "Ana", lastName: "Alonzo" }, for the invite form. */
export function splitName(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: words[0] ?? "", lastName: words.slice(1).join(" ") };
}
