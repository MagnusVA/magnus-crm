import type { Id } from "@/convex/_generated/dataModel";
import type { MemberProfile, MemberRole } from "@/convex/reports/member";
import type { CloserRow, PeopleClosers } from "@/convex/reports/people";
import type { PeopleRoleReport, PeopleRoleRow } from "@/convex/reports/peopleRoles";
import type { ReportColumn, ReportDocument, ReportRecord, ReportTable } from "@/lib/operations-reports/document";
import type { ReportTermKey } from "@/lib/reporting/definitions";
import { definitionsTable } from "@/lib/reporting/export";
import { formatCount, formatMinutes, formatMoney, formatRate, median, plural, rate, rankCurrencies } from "./report-format";

// The People roster and the member report, shaped without React so the
// tables, the team medians and the exports read the same numbers.

// ─── Tabs ────────────────────────────────────────────────────────────────────

export type RosterTab = "everyone" | MemberRole;

/** `?role=` values; no parameter means Everyone. Slack Qualifications redirects to `?role=setters`. */
export const ROLE_PARAM: Record<MemberRole, string> = {
  closer: "closers",
  setter: "setters",
  dm_closer: "dm_closers",
  lead_gen: "lead_gen",
};

export function parseRosterTab(param: string | null): RosterTab {
  const found = (Object.keys(ROLE_PARAM) as MemberRole[]).find((role) => ROLE_PARAM[role] === param);
  return found ?? "everyone";
}

/** The URL's query with `role` set (or removed for Everyone), every other parameter kept. */
export function withRosterTab(params: URLSearchParams, tab: RosterTab) {
  const next = new URLSearchParams(params.toString());
  if (tab === "everyone") next.delete("role");
  else next.set("role", ROLE_PARAM[tab]);
  const query = next.toString();
  return query ? `?${query}` : "";
}

// ─── Metrics per role ────────────────────────────────────────────────────────

export type RoleReports = {
  closers: PeopleClosers;
  setters: PeopleRoleReport;
  dmClosers: PeopleRoleReport;
  leadGen: PeopleRoleReport;
};

function amountIn(rows: ReadonlyArray<{ currency: string; amountMinor: number }>, currency: string) {
  return rows.filter((row) => row.currency.toUpperCase() === currency).reduce((sum, row) => sum + row.amountMinor, 0);
}

export function closerMetrics(row: CloserRow, currency: string) {
  const recorded = row.held + row.noShow;
  const cash = row.cash.filter((money) => money.currency.toUpperCase() === currency);
  return {
    due: row.due,
    held: row.held,
    noShow: row.noShow,
    notRecorded: row.notRecorded,
    recorded,
    showRate: rate(row.held, recorded),
    recordedRate: rate(recorded, row.due),
    closeRate: rate(row.cohortWon, row.cohortDeals),
    cohortWon: row.cohortWon,
    cohortDeals: row.cohortDeals,
    dealsWon: row.dealsWon,
    cashMinor: cash.reduce((sum, money) => sum + money.cashMinor, 0),
    finalMinor: cash.reduce((sum, money) => sum + money.finalMinor, 0),
    payments: row.payments,
    toRecord: median(row.recordMinutes),
  };
}

export function setterMetrics(row: PeopleRoleRow, currency: string) {
  return {
    qualifications: row.qualifications,
    hours: row.scheduledHours,
    perHour: row.scheduledHours > 0 ? row.qualifications / row.scheduledHours : null,
    dealsCredited: row.dealsCredited,
    booked: row.booked,
    bookRate: row.bookRate.rate,
    held: row.held,
    won: row.won,
    cashMinor: amountIn(row.byCurrency, currency),
  };
}

export function dmMetrics(row: PeopleRoleRow, currency: string) {
  return {
    bookings: row.bookings,
    hours: row.scheduledHours,
    perHour: row.scheduledHours > 0 ? row.bookings / row.scheduledHours : null,
    held: row.held,
    noShow: row.noShow,
    notRecorded: row.notRecorded,
    showRate: rate(row.held, row.held + row.noShow),
    recordedRate: rate(row.held + row.noShow, row.held + row.noShow + row.notRecorded),
    won: row.won,
    cashMinor: amountIn(row.byCurrency, currency),
  };
}

export function leadGenMetrics(row: PeopleRoleRow, currency: string) {
  return {
    captures: row.captures,
    people: row.uniquePeople,
    resparks: row.resparks,
    hours: row.scheduledHours,
    perHour: row.scheduledHours > 0 ? row.captures / row.scheduledHours : null,
    dealsCredited: row.dealsCredited,
    captureDeals: row.dealsCreditedBySource.capture,
    resparkDeals: row.dealsCreditedBySource.respark,
    won: row.won,
    cashMinor: amountIn(row.byCurrency, currency),
  };
}

/** Every currency money appears in across the four reports, main one first. */
export function rosterCurrencies(reports: Partial<RoleReports>): string[] {
  return rankCurrencies([
    ...(reports.closers?.rows ?? []).map((row) => row.cash),
    ...(reports.closers ? [reports.closers.unattributedCash] : []),
    ...[reports.setters, reports.dmClosers, reports.leadGen].flatMap((report) => (report?.rows ?? []).map((row) => row.byCurrency)),
  ]);
}

/** Person rows first by name, then DM team rows, then the unlinked row last. */
export function orderRoleRows(rows: readonly PeopleRoleRow[]) {
  const rank = (row: PeopleRoleRow) => (row.teamMemberId ? 0 : row.key.startsWith("team:") ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** A role row with anything in the range: quiet rows don't pull a team median down. */
export function roleRowActive(role: Exclude<MemberRole, "closer">, row: PeopleRoleRow) {
  if (role === "setter") return row.qualifications > 0 || row.dealsCredited > 0 || row.byCurrency.length > 0;
  if (role === "dm_closer") return row.bookings > 0 || row.dealsCredited > 0 || row.byCurrency.length > 0;
  return row.captures > 0 || row.resparks > 0 || row.dealsCredited > 0 || row.byCurrency.length > 0;
}

export function closerRowActive(row: CloserRow) {
  return row.due > 0 || row.payments > 0 || row.cohortDeals > 0 || row.canceled > 0 || row.moved > 0;
}

/**
 * The team's median of one figure, over linked people who did something in
 * the range and have a value (a rate needs a base). Null when nobody does.
 */
export function teamMedian<Row>(rows: readonly Row[], value: (row: Row) => number | null): number | null {
  return median(rows.map(value).filter((entry): entry is number => entry !== null && Number.isFinite(entry)));
}

// ─── Everyone ────────────────────────────────────────────────────────────────

export type EveryoneRow = {
  teamMemberId: Id<"teamMembers">;
  name: string;
  isActive: boolean;
  roles: MemberRole[];
  closer: CloserRow | null;
  setter: PeopleRoleRow | null;
  dmCloser: PeopleRoleRow | null;
  leadGen: PeopleRoleRow | null;
};

export type UnlinkedRow = { key: string; role: MemberRole; name: string; closer: CloserRow | null; record: PeopleRoleRow | null };

const ROLE_ORDER: readonly MemberRole[] = ["closer", "setter", "dm_closer", "lead_gen"];

/**
 * The Everyone tab's "Partial." sentence, or null when all four reports read
 * every record. Everyone merges the four, so one capped reader is enough.
 */
export function everyonePartialNote(reports: RoleReports): string | null {
  const capped =
    reports.closers.partial ||
    reports.closers.paymentsPartial ||
    reports.closers.cohortPartial ||
    reports.setters.isTruncated ||
    reports.dmClosers.isTruncated ||
    reports.leadGen.isTruncated;
  return capped
    ? "Too many records in this range to read every one, so credited cash is a lower bound. Narrow the range for exact figures."
    : null;
}

/**
 * One row per team member, joining the role reports on `teamMemberId`. A
 * member's roles come from their linked records and from the reports, so a
 * former setter still shows as one. Records with no member, and phone closer
 * logins with no member, go under "Not linked to a member". Credited cash
 * stays per role: it's never added into one figure for a person.
 */
export function buildEveryone(members: readonly MemberProfile[], reports: RoleReports) {
  const rows = new Map<Id<"teamMembers">, EveryoneRow>();
  const row = (teamMemberId: Id<"teamMembers">, name: string) => {
    let found = rows.get(teamMemberId);
    if (!found) {
      found = { teamMemberId, name, isActive: true, roles: [], closer: null, setter: null, dmCloser: null, leadGen: null };
      rows.set(teamMemberId, found);
    }
    return found;
  };
  for (const member of members) {
    const found = row(member.teamMemberId, member.name);
    found.isActive = member.isActive;
    found.roles.push(...member.roles);
  }
  const unlinked: UnlinkedRow[] = [];
  for (const closer of reports.closers.rows) {
    if (!closer.teamMemberId) {
      unlinked.push({ key: `closer:${closer.userId}`, role: "closer", name: closer.name, closer, record: null });
      continue;
    }
    const found = row(closer.teamMemberId, closer.name);
    found.closer = closer;
    found.roles.push("closer");
    if (!members.some((member) => member.teamMemberId === closer.teamMemberId)) found.isActive = closer.isActive;
  }
  const roleReports: Array<[Exclude<MemberRole, "closer">, PeopleRoleReport, "setter" | "dmCloser" | "leadGen"]> = [
    ["setter", reports.setters, "setter"],
    ["dm_closer", reports.dmClosers, "dmCloser"],
    ["lead_gen", reports.leadGen, "leadGen"],
  ];
  for (const [role, report, field] of roleReports) {
    for (const record of report.rows) {
      if (record.teamMemberId) {
        const found = row(record.teamMemberId, record.name);
        found[field] = record;
        found.roles.push(role);
      } else if (!record.key.startsWith("team:")) {
        unlinked.push({ key: `${role}:${record.key}`, role, name: record.name, closer: null, record });
      }
    }
  }
  const everyone = [...rows.values()]
    .map((entry) => ({ ...entry, roles: ROLE_ORDER.filter((role) => entry.roles.includes(role)) }))
    .filter((entry) => entry.roles.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name) || a.teamMemberId.localeCompare(b.teamMemberId));
  return { everyone, unlinked };
}

/** One member's credited cash in one role and currency, or null when they don't work the role. */
export function roleCash(entry: EveryoneRow, role: MemberRole, currency: string): number | null {
  if (role === "closer") return entry.closer ? closerMetrics(entry.closer, currency).cashMinor : entry.roles.includes("closer") ? 0 : null;
  const record = role === "setter" ? entry.setter : role === "dm_closer" ? entry.dmCloser : entry.leadGen;
  if (record) return amountIn(record.byCurrency, currency);
  return entry.roles.includes(role) ? 0 : null;
}

/** A short line of what the member did, from their first role with work in the range. */
export function headline(entry: EveryoneRow): string {
  const parts: string[] = [];
  if (entry.closer) {
    const m = closerMetrics(entry.closer, "USD");
    parts.push(`${formatCount(m.held)} held · ${formatRate(m.showRate)} show`);
  }
  if (entry.setter) parts.push(`${formatCount(entry.setter.qualifications)} qualified`);
  if (entry.dmCloser) parts.push(plural(entry.dmCloser.bookings, "booking"));
  if (entry.leadGen) parts.push(plural(entry.leadGen.captures, "capture"));
  return parts.length > 0 ? parts.join(" · ") : "Nothing in this range";
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const PEOPLE_TERMS: Record<RosterTab, readonly ReportTermKey[]> = {
  everyone: ["creditedCash", "cash"],
  closer: ["callsDue", "notRecorded", "showRate", "recorded", "closeRate", "dealsWon", "cash", "finalCash", "timeToRecord"],
  setter: ["perScheduledHour", "bookRate", "creditedCash"],
  dm_closer: ["bookingsMade", "perScheduledHour", "showRate", "creditedCash"],
  lead_gen: ["perScheduledHour", "creditedCash"],
};

const money = (key: string, label: string): ReportColumn => ({ key, label, format: "money", currencyKey: "currency" });
const number = (key: string, label: string): ReportColumn => ({ key, label, format: "number" });
const percent = (key: string, label: string): ReportColumn => ({ key, label, format: "percent" });
const decimal = (key: string, label: string): ReportColumn => ({ key, label, format: "decimal" });

export function closerTable(rows: readonly CloserRow[], currency: string, title = "Phone closers"): ReportTable {
  return {
    title,
    columns: [
      { key: "name", label: "Phone closer" },
      number("due", "Due"),
      number("held", "Held"),
      number("noShow", "No-show"),
      number("notRecorded", "Not recorded"),
      percent("showRate", "Show rate"),
      percent("recorded", "Recorded"),
      percent("closeRate", "Close rate"),
      number("dealsWon", "Deals won"),
      { key: "currency", label: "Currency" },
      money("cash", "Cash"),
      money("finalCash", "Final cash"),
      { key: "toRecord", label: "Time to record" },
    ],
    rows: rows.map((row) => {
      const m = closerMetrics(row, currency);
      return {
        name: row.isActive ? row.name : `${row.name} (inactive)`,
        due: m.due,
        held: m.held,
        noShow: m.noShow,
        notRecorded: m.notRecorded,
        showRate: m.showRate,
        recorded: m.recordedRate,
        closeRate: m.closeRate,
        dealsWon: m.dealsWon,
        currency,
        cash: m.cashMinor,
        finalCash: m.finalMinor,
        toRecord: formatMinutes(m.toRecord),
      };
    }),
  };
}

export function roleTable(role: Exclude<MemberRole, "closer">, rows: readonly PeopleRoleRow[], currency: string, title?: string): ReportTable {
  const name = (row: PeopleRoleRow) => row.name;
  if (role === "setter") {
    return {
      title: title ?? "Setters",
      columns: [
        { key: "name", label: "Setter" },
        number("qualifications", "Qualified"),
        decimal("hours", "Scheduled hours"),
        decimal("perHour", "Per hour"),
        number("dealsCredited", "Deals credited"),
        number("booked", "Booked"),
        percent("bookRate", "Book rate"),
        number("held", "Held"),
        number("won", "Won"),
        { key: "currency", label: "Currency" },
        money("cash", "Credited cash"),
      ],
      rows: rows.map((row) => {
        const m = setterMetrics(row, currency);
        return { name: name(row), qualifications: m.qualifications, hours: m.hours, perHour: m.perHour, dealsCredited: m.dealsCredited, booked: m.booked, bookRate: m.bookRate, held: m.held, won: m.won, currency, cash: m.cashMinor };
      }),
    };
  }
  if (role === "dm_closer") {
    return {
      title: title ?? "DM closers",
      columns: [
        { key: "name", label: "DM closer" },
        { key: "team", label: "Team" },
        number("bookings", "Bookings"),
        decimal("perHour", "Per hour"),
        number("held", "Held"),
        number("noShow", "No-show"),
        percent("showRate", "Show rate"),
        number("won", "Won"),
        { key: "currency", label: "Currency" },
        money("cash", "Credited cash"),
      ],
      rows: rows.map((row) => {
        const m = dmMetrics(row, currency);
        return { name: name(row), team: row.teams.map((team) => team.name).join(", "), bookings: m.bookings, perHour: m.perHour, held: m.held, noShow: m.noShow, showRate: m.showRate, won: m.won, currency, cash: m.cashMinor };
      }),
    };
  }
  return {
    title: title ?? "Lead gen",
    columns: [
      { key: "name", label: "Lead generator" },
      number("captures", "Captures"),
      number("people", "People"),
      number("resparks", "Resparks"),
      decimal("perHour", "Per hour"),
      number("captureDeals", "Deals from captures"),
      number("resparkDeals", "Deals from resparks"),
      number("won", "Won"),
      { key: "currency", label: "Currency" },
      money("cash", "Credited cash"),
    ],
    rows: rows.map((row) => {
      const m = leadGenMetrics(row, currency);
      return { name: name(row), captures: m.captures, people: m.people, resparks: m.resparks, perHour: m.perHour, captureDeals: m.captureDeals, resparkDeals: m.resparkDeals, won: m.won, currency, cash: m.cashMinor };
    }),
  };
}

function everyoneTable(everyone: readonly EveryoneRow[], currency: string): ReportTable {
  return {
    title: "Everyone",
    columns: [
      { key: "name", label: "Member" },
      { key: "roles", label: "Roles" },
      { key: "active", label: "Active" },
      { key: "currency", label: "Currency" },
      money("closer", "Credited cash as phone closer"),
      money("setter", "Credited cash as setter"),
      money("dm", "Credited cash as DM closer"),
      money("leadGen", "Credited cash as lead gen"),
    ],
    rows: everyone.map((entry) => ({
      name: entry.name,
      roles: entry.roles.join(", "),
      active: entry.isActive ? "Yes" : "No",
      currency,
      closer: roleCash(entry, "closer", currency),
      setter: roleCash(entry, "setter", currency),
      dm: roleCash(entry, "dm_closer", currency),
      leadGen: roleCash(entry, "lead_gen", currency),
    })),
  };
}

type DocumentFrame = { period: string; boundary: string; generatedAt: number };

/** The roster tab as a `ReportDocument`: a few figures, the tab's table, unlinked records and Definitions. */
export function buildPeopleDocument(input: DocumentFrame & {
  tab: RosterTab;
  reports: RoleReports;
  members: readonly MemberProfile[];
  currency: string;
}): ReportDocument {
  const { reports, currency, tab } = input;
  const { everyone, unlinked } = buildEveryone(input.members, reports);
  // The role tabs' exports carry no partial note yet; Everyone's goes on the
  // filters line, as the Calls export does.
  const partial = tab === "everyone" ? everyonePartialNote(reports) : null;
  const tables: ReportTable[] = [];
  if (tab === "everyone") {
    tables.push(everyoneTable(everyone, currency));
    if (unlinked.length > 0) {
      tables.push({
        title: "Not linked to a member",
        columns: [{ key: "role", label: "Role" }, { key: "name", label: "Record" }, { key: "currency", label: "Currency" }, money("cash", "Credited cash")],
        rows: unlinked.map((row) => ({
          role: row.role,
          name: row.name,
          currency,
          cash: row.closer ? closerMetrics(row.closer, currency).cashMinor : amountIn(row.record?.byCurrency ?? [], currency),
        })),
      });
    }
  } else if (tab === "closer") {
    tables.push(closerTable(reports.closers.rows, currency));
  } else {
    const report = tab === "setter" ? reports.setters : tab === "dm_closer" ? reports.dmClosers : reports.leadGen;
    tables.push(roleTable(tab, orderRoleRows(report.rows), currency));
  }
  tables.push(definitionsTable(PEOPLE_TERMS[tab]));
  const unattributed = amountIn(
    reports.closers.unattributedCash.map((row) => ({ currency: row.currency, amountMinor: row.cashMinor })),
    currency,
  );
  return {
    title: "People",
    period: input.period,
    generatedAt: input.generatedAt,
    boundary: input.boundary,
    filters: [
      tab === "everyone" ? "Everyone" : ROLE_PARAM[tab],
      `money in ${currency}`,
      ...(partial ? [`Partial. ${partial}`] : []),
    ].join(" · "),
    summary: [
      { label: "Team members", value: formatCount(everyone.length) },
      { label: "Phone closers", value: formatCount(reports.closers.rows.length) },
      { label: "Setters", value: formatCount(reports.setters.rows.length) },
      { label: "DM closers", value: formatCount(reports.dmClosers.rows.length) },
      { label: "Lead gen", value: formatCount(reports.leadGen.rows.length) },
      { label: `Cash with no closer (${currency})`, value: formatMoney(unattributed, currency) },
    ],
    tables,
  };
}

// ─── The member report ───────────────────────────────────────────────────────

export type MemberFigure = {
  key: string;
  label: string;
  term?: ReportTermKey;
  value: number | null;
  display: string;
  proof?: string;
  /** The team's median, already formatted; absent for non-admins. */
  team?: string;
  money?: boolean;
};

const fmtRate = (value: number | null) => formatRate(value);
const fmtCount = (value: number | null) => (value === null ? "—" : formatCount(value));
const fmtPerHour = (value: number | null) => (value === null ? "No schedule" : `${value.toFixed(2)}/h`);

function withTeam<Row>(
  figure: Omit<MemberFigure, "team">,
  teamRows: readonly Row[] | null,
  pick: (row: Row) => number | null,
  format: (value: number | null) => string,
): MemberFigure {
  if (!teamRows) return figure;
  const value = teamMedian(teamRows, pick);
  return { ...figure, team: value === null ? "—" : format(value) };
}

/** A phone closer's figures, each beside the team median when the viewer may read the roster. */
export function closerMemberFigures(row: CloserRow | null, team: readonly CloserRow[] | null, currency: string): MemberFigure[] {
  const m = row ? closerMetrics(row, currency) : null;
  const teamRows = team ? team.filter((entry) => entry.teamMemberId && closerRowActive(entry)) : null;
  const pick = <T,>(f: (metrics: ReturnType<typeof closerMetrics>) => T) => (entry: CloserRow) => f(closerMetrics(entry, currency));
  return [
    withTeam({ key: "due", label: "Calls due", term: "callsDue", value: m?.due ?? null, display: fmtCount(m?.due ?? null), proof: m ? `${formatCount(m.held)} held · ${formatCount(m.noShow)} no-show · ${formatCount(m.notRecorded)} not recorded` : undefined }, teamRows, pick((x) => x.due), fmtCount),
    withTeam({ key: "showRate", label: "Show rate", term: "showRate", value: m?.showRate ?? null, display: fmtRate(m?.showRate ?? null), proof: m ? `${formatRate(m.recordedRate)} recorded` : undefined }, teamRows, pick((x) => x.showRate), fmtRate),
    withTeam({ key: "recorded", label: "Recorded", term: "recorded", value: m?.recordedRate ?? null, display: fmtRate(m?.recordedRate ?? null), proof: m ? (m.due > 0 ? `${formatCount(m.recorded)} of ${formatCount(m.due)} calls due` : "No calls due yet") : undefined }, teamRows, pick((x) => x.recordedRate), fmtRate),
    withTeam({ key: "closeRate", label: "Close rate", term: "closeRate", value: m?.closeRate ?? null, display: fmtRate(m?.closeRate ?? null), proof: m ? (m.cohortDeals > 0 ? `${formatCount(m.cohortWon)} of ${formatCount(m.cohortDeals)} deals won` : "No deals had a first held call") : undefined }, teamRows, pick((x) => x.closeRate), fmtRate),
    withTeam({ key: "dealsWon", label: "Deals won", term: "dealsWon", value: m?.dealsWon ?? null, display: fmtCount(m?.dealsWon ?? null) }, teamRows, pick((x) => x.dealsWon), fmtCount),
    withTeam({ key: "cash", label: `Cash · ${currency}`, term: "cash", money: true, value: m?.cashMinor ?? null, display: m ? formatMoney(m.cashMinor, currency) : "—", proof: m ? `${formatMoney(m.finalMinor, currency)} final · ${formatCount(m.payments)} payments` : undefined }, teamRows, pick((x) => x.cashMinor), (value) => (value === null ? "—" : formatMoney(value, currency))),
    withTeam({ key: "toRecord", label: "Time to record", term: "timeToRecord", value: m?.toRecord ?? null, display: formatMinutes(m?.toRecord ?? null), proof: "Median after the call ended" }, teamRows, pick((x) => x.toRecord), formatMinutes),
  ];
}

/** A setter's, DM closer's or lead generator's figures, with the team median beside each. */
export function roleMemberFigures(
  role: Exclude<MemberRole, "closer">,
  row: PeopleRoleRow | null,
  team: readonly PeopleRoleRow[] | null,
  currency: string,
): MemberFigure[] {
  const teamRows = team ? team.filter((entry) => entry.teamMemberId && roleRowActive(role, entry)) : null;
  const cashFormat = (value: number | null) => (value === null ? "—" : formatMoney(value, currency));
  if (role === "setter") {
    const m = row ? setterMetrics(row, currency) : null;
    const pick = (f: (x: ReturnType<typeof setterMetrics>) => number | null) => (entry: PeopleRoleRow) => f(setterMetrics(entry, currency));
    return [
      withTeam({ key: "qualifications", label: "Qualified", value: m?.qualifications ?? null, display: fmtCount(m?.qualifications ?? null), proof: m ? `${formatCount(m.hours)} h scheduled` : undefined }, teamRows, pick((x) => x.qualifications), fmtCount),
      withTeam({ key: "perHour", label: "Per hour", term: "perScheduledHour", value: m?.perHour ?? null, display: fmtPerHour(m?.perHour ?? null) }, teamRows, pick((x) => x.perHour), fmtPerHour),
      withTeam({ key: "bookRate", label: "Book rate", term: "bookRate", value: m?.bookRate ?? null, display: fmtRate(m?.bookRate ?? null), proof: m ? (m.dealsCredited > 0 ? `${formatCount(m.booked)} of ${formatCount(m.dealsCredited)} deals booked` : "No deals qualified") : undefined }, teamRows, pick((x) => x.bookRate), fmtRate),
      withTeam({ key: "held", label: "Held", value: m?.held ?? null, display: fmtCount(m?.held ?? null), proof: "Deals with a held call" }, teamRows, pick((x) => x.held), fmtCount),
      withTeam({ key: "won", label: "Won", value: m?.won ?? null, display: fmtCount(m?.won ?? null) }, teamRows, pick((x) => x.won), fmtCount),
      withTeam({ key: "cash", label: `Credited cash · ${currency}`, term: "creditedCash", money: true, value: m?.cashMinor ?? null, display: cashFormat(m?.cashMinor ?? null) }, teamRows, pick((x) => x.cashMinor), cashFormat),
    ];
  }
  if (role === "dm_closer") {
    const m = row ? dmMetrics(row, currency) : null;
    const pick = (f: (x: ReturnType<typeof dmMetrics>) => number | null) => (entry: PeopleRoleRow) => f(dmMetrics(entry, currency));
    return [
      withTeam({ key: "bookings", label: "Bookings", term: "bookingsMade", value: m?.bookings ?? null, display: fmtCount(m?.bookings ?? null), proof: m ? `${formatCount(m.hours)} h scheduled` : undefined }, teamRows, pick((x) => x.bookings), fmtCount),
      withTeam({ key: "perHour", label: "Per hour", term: "perScheduledHour", value: m?.perHour ?? null, display: fmtPerHour(m?.perHour ?? null) }, teamRows, pick((x) => x.perHour), fmtPerHour),
      withTeam({ key: "showRate", label: "Show rate", term: "showRate", value: m?.showRate ?? null, display: fmtRate(m?.showRate ?? null), proof: m ? `${formatCount(m.held)} held · ${formatCount(m.noShow)} no-show · ${formatRate(m.recordedRate)} recorded` : undefined }, teamRows, pick((x) => x.showRate), fmtRate),
      withTeam({ key: "won", label: "Won", value: m?.won ?? null, display: fmtCount(m?.won ?? null) }, teamRows, pick((x) => x.won), fmtCount),
      withTeam({ key: "cash", label: `Credited cash · ${currency}`, term: "creditedCash", money: true, value: m?.cashMinor ?? null, display: cashFormat(m?.cashMinor ?? null) }, teamRows, pick((x) => x.cashMinor), cashFormat),
    ];
  }
  const m = row ? leadGenMetrics(row, currency) : null;
  const pick = (f: (x: ReturnType<typeof leadGenMetrics>) => number | null) => (entry: PeopleRoleRow) => f(leadGenMetrics(entry, currency));
  return [
    withTeam({ key: "captures", label: "Captures", value: m?.captures ?? null, display: fmtCount(m?.captures ?? null), proof: m ? `${formatCount(m.people)} people · ${formatCount(m.hours)} h scheduled` : undefined }, teamRows, pick((x) => x.captures), fmtCount),
    withTeam({ key: "perHour", label: "Per hour", term: "perScheduledHour", value: m?.perHour ?? null, display: fmtPerHour(m?.perHour ?? null) }, teamRows, pick((x) => x.perHour), fmtPerHour),
    withTeam({ key: "resparks", label: "Resparks", value: m?.resparks ?? null, display: fmtCount(m?.resparks ?? null) }, teamRows, pick((x) => x.resparks), fmtCount),
    withTeam({ key: "deals", label: "Deals credited", value: m?.dealsCredited ?? null, display: fmtCount(m?.dealsCredited ?? null), proof: m ? `${formatCount(m.captureDeals)} from captures · ${formatCount(m.resparkDeals)} from resparks` : undefined }, teamRows, pick((x) => x.dealsCredited), fmtCount),
    withTeam({ key: "won", label: "Won", value: m?.won ?? null, display: fmtCount(m?.won ?? null) }, teamRows, pick((x) => x.won), fmtCount),
    withTeam({ key: "cash", label: `Credited cash · ${currency}`, term: "creditedCash", money: true, value: m?.cashMinor ?? null, display: cashFormat(m?.cashMinor ?? null) }, teamRows, pick((x) => x.cashMinor), cashFormat),
  ];
}

export type MemberSection = {
  role: MemberRole;
  figures: MemberFigure[];
  items: { title: string; table: ReportTable } | null;
  days: ReportTable | null;
};

/** The member report as a `ReportDocument`: each role's figures (with team medians), days and items. */
export function buildMemberDocument(input: DocumentFrame & {
  profile: MemberProfile;
  currency: string;
  sections: readonly MemberSection[];
}): ReportDocument {
  const roleName: Record<MemberRole, string> = { closer: "Phone closer", setter: "Setter", dm_closer: "DM closer", lead_gen: "Lead gen" };
  const summary = input.sections.flatMap((section) =>
    section.figures.map((figure) => ({
      label: `${roleName[section.role]} · ${figure.label}`,
      value: figure.team !== undefined ? `${figure.display} (team median ${figure.team})` : figure.display,
    })),
  );
  const terms = new Set<ReportTermKey>();
  input.sections.forEach((section) => section.figures.forEach((figure) => figure.term && terms.add(figure.term)));
  const tables: ReportTable[] = [];
  for (const section of input.sections) {
    if (section.days) tables.push(section.days);
    if (section.items) tables.push(section.items.table);
  }
  tables.push(definitionsTable([...terms]));
  return {
    title: `Member report · ${input.profile.name}`,
    period: input.period,
    generatedAt: input.generatedAt,
    boundary: input.boundary,
    filters: `${input.profile.roles.map((role) => roleName[role]).join(", ") || "No linked roles"} · money in ${input.currency}`,
    summary: summary.length > 0 ? summary : [{ label: "Roles", value: "No linked role records" }],
    tables,
  };
}

/** Days as a table: one row per business day with the role's counts. */
export function daysTable(title: string, columns: ReportColumn[], rows: ReportRecord[]): ReportTable {
  return { title, columns: [{ key: "day", label: "Business day" }, ...columns], rows };
}

