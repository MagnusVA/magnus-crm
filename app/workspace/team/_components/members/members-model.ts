import type { Directory, DirectoryMember } from "@/convex/team/contracts";
import { formatHours, weekTotal, type WeekHours } from "../schedule-editor";

// Team › Members, in plain functions: what each row says (roles, teams,
// weeks, status), what the filters match, and what the CSV holds. The page
// and the band's figures both read from here, so they count the same way.

export type { Directory, DirectoryMember };
export type DirectoryTeam = Directory["teams"][number];

export type RoleFilter = "lead_gen" | "slack" | "dm_closer" | "phone_closer" | "admin" | "no_login";

export const ROLE_FILTERS: Array<{ value: RoleFilter; label: string }> = [
  { value: "phone_closer", label: "Phone closers" },
  { value: "lead_gen", label: "Lead gen" },
  { value: "slack", label: "Slack" },
  { value: "dm_closer", label: "DM closers" },
  { value: "admin", label: "Admins" },
  { value: "no_login", label: "No login" },
];

export function parseRoleFilter(value: string | null): RoleFilter | null {
  return ROLE_FILTERS.some((filter) => filter.value === value) ? (value as RoleFilter) : null;
}

// ─── Roles ────────────────────────────────────────────────────────────

export type RoleChip = { key: string; label: string; off: boolean };

function loginLive(member: DirectoryMember) {
  return Boolean(member.login && !member.login.removed);
}

/** A lead gen worker, or a Lead generator login whose worker record hasn't synced yet. */
export function hasLeadGen(member: DirectoryMember) {
  return member.leadGen.length > 0 || member.login?.role === "lead_generator";
}

/** The chips in ROLES: the login's role, then each role that gets credit. Off = that record is inactive. */
export function roleChips(member: DirectoryMember): RoleChip[] {
  const chips: RoleChip[] = [];
  const login = member.login;
  const loginOff = !loginLive(member);
  if (login?.role === "tenant_master") chips.push({ key: "owner", label: "Owner", off: loginOff });
  if (login?.role === "tenant_admin") chips.push({ key: "admin", label: "Admin", off: loginOff });
  if (login?.role === "closer") chips.push({ key: "phone_closer", label: "Phone closer", off: loginOff });
  if (hasLeadGen(member)) {
    const active = member.leadGen.length > 0 ? member.leadGen.some((worker) => worker.isActive) : !loginOff;
    chips.push({ key: "lead_gen", label: "Lead gen", off: !active });
  }
  if (member.slack.length > 0) {
    chips.push({ key: "slack", label: "Slack", off: member.slack.every((user) => user.isDeleted) });
  }
  if (member.dmClosers.length > 0) {
    chips.push({ key: "dm_closer", label: "DM closer", off: member.dmClosers.every((closer) => !closer.isActive) });
  }
  return chips;
}

export function matchesRole(member: DirectoryMember, role: RoleFilter) {
  switch (role) {
    case "lead_gen":
      return hasLeadGen(member);
    case "slack":
      return member.slack.length > 0;
    case "dm_closer":
      return member.dmClosers.length > 0;
    case "phone_closer":
      return member.login?.role === "closer";
    case "admin":
      return member.login?.role === "tenant_admin" || member.login?.role === "tenant_master";
    case "no_login":
      return member.login === null;
  }
}

// ─── Status ───────────────────────────────────────────────────────────

export type MemberStatus = "Active" | "Inactive" | "Invited" | "Removed";

/** Active while any of their records is. A pending invitation reads Invited; a removed login with nothing else, Removed. */
export function memberStatus(member: DirectoryMember): MemberStatus {
  if (member.login?.invitationPending && !member.login.removed) return "Invited";
  const active =
    loginLive(member) ||
    member.leadGen.some((worker) => worker.isActive) ||
    member.slack.some((user) => !user.isDeleted) ||
    member.dmClosers.some((closer) => closer.isActive);
  if (active) return "Active";
  return member.login?.removed ? "Removed" : "Inactive";
}

// ─── Teams ────────────────────────────────────────────────────────────

export type TeamLine = { teamId: string | null; name: string; via: string };

/**
 * TEAM: each distinct team and the role that puts them there ("Lead gen",
 * "DM links", or both). A lead generator on no team shows "No team". Empty
 * when they have no team role (Slack qualifiers have no team).
 */
export function teamLines(member: DirectoryMember, teamName: (teamId: string) => string): TeamLine[] {
  const lines = new Map<string, { teamId: string | null; via: Set<string> }>();
  const add = (teamId: string | null, via: string) => {
    const key = teamId ?? "none";
    const line = lines.get(key) ?? { teamId, via: new Set<string>() };
    line.via.add(via);
    lines.set(key, line);
  };
  for (const worker of member.leadGen) add(worker.teamId, "Lead gen");
  for (const closer of member.dmClosers) add(closer.teamId, "DM links");
  return [...lines.values()].map((line) => ({
    teamId: line.teamId,
    name: line.teamId ? teamName(line.teamId) : "No team",
    via: [...line.via].join(" and "),
  }));
}

export function teamIdsOf(member: DirectoryMember): string[] {
  return [
    ...member.leadGen.flatMap((worker) => (worker.teamId ? [worker.teamId] : [])),
    ...member.dmClosers.map((closer) => closer.teamId),
  ];
}

// ─── Weeks ────────────────────────────────────────────────────────────

export type RoleWeek = {
  key: string;
  role: "lead_gen" | "slack" | "dm_closer";
  label: string;
  week: WeekHours | null;
  total: number;
  active: boolean;
};

/**
 * One week per role record with a per-hour report (lead gen, Slack, DM
 * closer), never added together. A record that is no longer active drops out
 * while the member has an active one; an inactive member shows them all.
 */
export function roleWeeks(member: DirectoryMember, teamName: (teamId: string) => string): RoleWeek[] {
  const several = member.dmClosers.length > 1;
  const weeks: RoleWeek[] = [
    ...member.leadGen.map((worker) => ({
      key: `lead_gen:${worker.workerId}`,
      role: "lead_gen" as const,
      label: member.leadGen.length > 1 && worker.teamId ? `Lead gen · ${teamName(worker.teamId)}` : "Lead gen",
      week: worker.week,
      total: weekTotal(worker.week),
      active: worker.isActive,
    })),
    ...member.slack.map((user) => ({
      key: `slack:${user.slackUserId}`,
      role: "slack" as const,
      label: "Slack",
      week: user.week,
      total: weekTotal(user.week),
      active: !user.isDeleted,
    })),
    ...member.dmClosers.map((closer) => ({
      key: `dm_closer:${closer.dmCloserId}`,
      role: "dm_closer" as const,
      label: several ? `DM closer · ${teamName(closer.teamId)}` : "DM closer",
      week: closer.week,
      total: weekTotal(closer.week),
      active: closer.isActive,
    })),
  ];
  return weeks.some((week) => week.active) ? weeks.filter((week) => week.active) : weeks;
}

/** Hours a week of a member's active role records, for the band. */
export function activeHours(member: DirectoryMember) {
  return [
    ...member.leadGen.filter((worker) => worker.isActive).map((worker) => weekTotal(worker.week)),
    ...member.slack.filter((user) => !user.isDeleted).map((user) => weekTotal(user.week)),
    ...member.dmClosers.filter((closer) => closer.isActive).map((closer) => weekTotal(closer.week)),
  ].reduce((sum, hours) => sum + hours, 0);
}

// ─── Lines and search ─────────────────────────────────────────────────

/** The line under the name: the login's email, or what they are without one. */
export function loginLine(member: DirectoryMember) {
  const login = member.login;
  if (!login) {
    return member.slack.length > 0 && member.dmClosers.length === 0 && member.leadGen.length === 0
      ? "Slack only · no CRM login"
      : "No CRM login";
  }
  return login.invitationPending && !login.removed ? `${login.email} · invited` : login.email;
}

export function fold(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Name, emails, utm_medium and Slack handle, in one folded string. */
function searchText(member: DirectoryMember) {
  return fold(
    [
      member.name,
      member.login?.name,
      member.login?.email,
      ...member.leadGen.flatMap((worker) => [worker.name, worker.email]),
      ...member.slack.flatMap((user) => [user.name, user.handle, user.handle ? `@${user.handle}` : null]),
      ...member.dmClosers.flatMap((closer) => [closer.name, closer.utmMedium]),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export type MemberFilters = { q: string; role: RoleFilter | null; team: string | null };

export function matchesSearch(member: DirectoryMember, q: string) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = searchText(member);
  return words.every((word) => text.includes(word));
}

export function matchesTeam(member: DirectoryMember, team: string | null) {
  if (!team) return true;
  const ids = teamIdsOf(member);
  return team === "none" ? ids.length === 0 : ids.includes(team);
}

export function byName(left: DirectoryMember, right: DirectoryMember) {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

// ─── CSV ──────────────────────────────────────────────────────────────

export const CSV_HEADERS = [
  "Name",
  "Email",
  "Roles",
  "Teams",
  "Status",
  "Lead gen hours a week",
  "Slack hours a week",
  "DM closer hours a week",
];

export function csvRow(member: DirectoryMember, teamName: (teamId: string) => string): string[] {
  const weeks = roleWeeks(member, teamName);
  const hoursFor = (role: RoleWeek["role"]) => {
    const own = weeks.filter((week) => week.role === role);
    if (own.length === 0) return "";
    return own.map((week) => (week.total > 0 ? formatHours(week.total) : "No schedule")).join(" / ");
  };
  return [
    member.name,
    member.login?.email ?? "",
    roleChips(member)
      .map((chip) => chip.label)
      .join("; "),
    teamLines(member, teamName)
      .map((line) => `${line.name} (${line.via})`)
      .join("; "),
    memberStatus(member),
    hoursFor("lead_gen"),
    hoursFor("slack"),
    hoursFor("dm_closer"),
  ];
}
