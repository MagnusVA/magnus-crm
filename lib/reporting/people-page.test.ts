import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { MemberProfile } from "@/convex/reports/member";
import type { CloserRow, PeopleClosers } from "@/convex/reports/people";
import type { PeopleRoleReport, PeopleRoleRow } from "@/convex/reports/peopleRoles";
import {
  buildEveryone,
  buildMemberDocument,
  buildPeopleDocument,
  closerMemberFigures,
  parseRosterTab,
  roleCash,
  roleMemberFigures,
  rosterCurrencies,
  teamMedian,
  withRosterTab,
} from "@/app/workspace/reports/people/_components/people-data";
import { median, rangeQuery, rankCurrencies } from "@/app/workspace/reports/people/_components/report-format";

const member = (id: string) => id as Id<"teamMembers">;

function closer(overrides: Partial<CloserRow>): CloserRow {
  return {
    userId: "u" as Id<"users">,
    teamMemberId: null,
    name: "Closer",
    isActive: true,
    due: 0,
    held: 0,
    noShow: 0,
    notRecorded: 0,
    moved: 0,
    canceled: 0,
    firstHeld: 0,
    firstNoShow: 0,
    firstNotRecorded: 0,
    followUpHeld: 0,
    followUpNoShow: 0,
    recordMinutes: [],
    cohortDeals: 0,
    cohortWon: 0,
    dealsWon: 0,
    cash: [],
    payments: 0,
    ...overrides,
  };
}

function roleRow(overrides: Partial<PeopleRoleRow>): PeopleRoleRow {
  return {
    key: "unlinked",
    teamMemberId: null,
    teamId: null,
    name: "Not linked to a member",
    linked: false,
    teams: [],
    qualifications: 0,
    qualificationsByResult: {},
    dealsCredited: 0,
    dealIds: [],
    booked: 0,
    bookedDealIds: [],
    held: 0,
    heldDealIds: [],
    won: 0,
    wonDealIds: [],
    bookRate: { numerator: 0, denominator: 0, rate: null },
    bookings: 0,
    noShow: 0,
    notRecorded: 0,
    dealsWon: 0,
    captures: 0,
    uniquePeople: 0,
    personIds: [],
    resparks: 0,
    dealsCreditedBySource: { capture: 0, respark: 0 },
    captureDealIds: [],
    resparkDealIds: [],
    byCurrency: [],
    scheduledHours: 0,
    ...overrides,
  };
}

const report = (role: PeopleRoleReport["role"], rows: PeopleRoleRow[]): PeopleRoleReport => ({
  role,
  memberId: null,
  rows,
  days: [],
  items: [],
  isTruncated: false,
});

const closers = (rows: CloserRow[]): PeopleClosers => ({
  rows,
  unattributedCash: [{ currency: "USD", cashMinor: 230_000, finalMinor: 230_000 }],
  days: [],
  calls: [],
  callsPartial: false,
  partial: false,
  cohortPartial: false,
  paymentsPartial: false,
});

const ana = closer({
  userId: "ana" as Id<"users">,
  teamMemberId: member("m_ana"),
  name: "Ana",
  due: 10,
  held: 6,
  noShow: 2,
  notRecorded: 2,
  cohortDeals: 4,
  cohortWon: 1,
  recordMinutes: [20, 40],
  cash: [
    { currency: "USD", cashMinor: 500_000, finalMinor: 300_000 },
    { currency: "HNL", cashMinor: 1_000, finalMinor: 1_000 },
  ],
  payments: 3,
});
const beto = closer({ userId: "beto" as Id<"users">, teamMemberId: member("m_beto"), name: "Beto", due: 4, held: 4, cohortDeals: 2, cohortWon: 2 });
const loose = closer({ userId: "loose" as Id<"users">, name: "Loose login", due: 1, held: 1 });

const carlosSetter = roleRow({ key: "m_carlos", teamMemberId: member("m_carlos"), name: "Carlos", linked: true, qualifications: 12, scheduledHours: 6, byCurrency: [{ currency: "USD", amountMinor: 100_000 }] });
const carlosDm = roleRow({ key: "m_carlos", teamMemberId: member("m_carlos"), name: "Carlos", linked: true, bookings: 5, byCurrency: [{ currency: "USD", amountMinor: 250_000 }] });
const anaSetter = roleRow({ key: "m_ana", teamMemberId: member("m_ana"), name: "Ana", linked: true, qualifications: 2 });
const teamRow = roleRow({ key: "team:north", name: "North", bookings: 3 });
const unlinkedSetter = roleRow({ qualifications: 4, byCurrency: [{ currency: "USD", amountMinor: 9_900 }] });

const reports = {
  closers: closers([ana, beto, loose]),
  setters: report("setter", [anaSetter, carlosSetter, unlinkedSetter]),
  dmClosers: report("dm_closer", [carlosDm, teamRow]),
  leadGen: report("lead_gen", []),
};

const profiles: MemberProfile[] = [
  { teamMemberId: member("m_ana"), name: "Ana", roles: ["closer"], userId: null, isActive: true },
  { teamMemberId: member("m_carlos"), name: "Carlos", roles: ["setter", "dm_closer"], userId: null, isActive: false },
  { teamMemberId: member("m_admin"), name: "Admin only", roles: [], userId: null, isActive: true },
];

describe("People tab in the URL", () => {
  it("reads ?role= and keeps the range when switching", () => {
    expect(parseRosterTab(null)).toBe("everyone");
    expect(parseRosterTab("setters")).toBe("setter");
    expect(parseRosterTab("dm_closers")).toBe("dm_closer");
    expect(parseRosterTab("nonsense")).toBe("everyone");
    const params = new URLSearchParams("range=custom&from=2026-10-01&to=2026-10-31&role=setters&analytics=preview");
    expect(withRosterTab(params, "closer")).toBe("?range=custom&from=2026-10-01&to=2026-10-31&role=closers&analytics=preview");
    expect(withRosterTab(params, "everyone")).toBe("?range=custom&from=2026-10-01&to=2026-10-31&analytics=preview");
    expect(rangeQuery(params)).toBe("?range=custom&from=2026-10-01&to=2026-10-31");
  });
});

describe("Everyone", () => {
  it("joins the role reports on the team member, once per person, with every role", () => {
    const { everyone, unlinked } = buildEveryone(profiles, reports);
    expect(everyone.map((row) => [row.name, row.roles, row.isActive])).toEqual([
      ["Ana", ["closer", "setter"], true],
      ["Beto", ["closer"], true],
      ["Carlos", ["setter", "dm_closer"], false],
    ]);
    // Records with no member, and a closer login with none, are listed apart; DM team rows aren't people.
    expect(unlinked.map((row) => [row.role, row.name])).toEqual([
      ["closer", "Loose login"],
      ["setter", "Not linked to a member"],
    ]);
  });

  it("keeps credited cash per role and per currency, never summed into one figure", () => {
    const carlos = buildEveryone(profiles, reports).everyone.find((row) => row.name === "Carlos")!;
    expect(roleCash(carlos, "setter", "USD")).toBe(100_000);
    expect(roleCash(carlos, "dm_closer", "USD")).toBe(250_000);
    expect(roleCash(carlos, "closer", "USD")).toBeNull();
    const anaRow = buildEveryone(profiles, reports).everyone.find((row) => row.name === "Ana")!;
    expect(roleCash(anaRow, "closer", "HNL")).toBe(1_000);
    expect(roleCash(anaRow, "setter", "USD")).toBe(0);
  });
});

describe("Currencies and medians", () => {
  it("leads with the currency most rows hold, then US dollars, never by amount", () => {
    expect(rankCurrencies([[{ currency: "eur" }], [{ currency: "EUR" }, { currency: "USD" }]])).toEqual(["EUR", "USD"]);
    expect(rankCurrencies([[{ currency: "HNL" }], [{ currency: "USD" }]])).toEqual(["USD", "HNL"]);
    expect(rosterCurrencies(reports)[0]).toBe("USD");
  });

  it("takes the median of the values that exist", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(teamMedian([1, null, 3], (value) => value)).toBe(2);
    expect(teamMedian([null], (value) => value)).toBeNull();
  });

  it("puts the team median beside a closer's figures only when the roster is given", () => {
    const withTeam = closerMemberFigures(ana, reports.closers.rows, "USD");
    const showRate = withTeam.find((figure) => figure.key === "showRate")!;
    expect(showRate.display).toBe("75.0%");
    // Ana 6/8 and Beto 4/4; the unlinked login is left out of the team.
    expect(showRate.team).toBe("87.5%");
    expect(withTeam.find((figure) => figure.key === "cash")).toMatchObject({ display: "$5,000.00", team: "$2,500.00" });
    const own = closerMemberFigures(ana, null, "USD");
    expect(own.every((figure) => figure.team === undefined)).toBe(true);
  });

  it("reads a setter's rate per scheduled hour and the team median over active setters", () => {
    const figures = roleMemberFigures("setter", carlosSetter, reports.setters.rows, "USD");
    expect(figures.find((figure) => figure.key === "perHour")).toMatchObject({ display: "2.00/h" });
    expect(figures.find((figure) => figure.key === "qualifications")).toMatchObject({ display: "12", team: "7" });
  });
});

describe("People exports", () => {
  it("exports the chosen tab, the unlinked records and definitions", () => {
    const everyone = buildPeopleDocument({ tab: "everyone", reports, members: profiles, currency: "USD", period: "p", boundary: "b", generatedAt: 0 });
    expect(everyone.tables.map((table) => table.title)).toEqual(["Everyone", "Not linked to a member", "Definitions"]);
    expect(everyone.summary.find((item) => item.label === "Cash with no closer (USD)")?.value).toBe("$2,300.00");
    const setters = buildPeopleDocument({ tab: "setter", reports, members: profiles, currency: "USD", period: "p", boundary: "b", generatedAt: 0 });
    expect(setters.tables[0].title).toBe("Setters");
    expect(setters.tables[0].rows.map((row) => row.name)).toEqual(["Ana", "Carlos", "Not linked to a member"]);
    const phone = buildPeopleDocument({ tab: "closer", reports, members: profiles, currency: "USD", period: "p", boundary: "b", generatedAt: 0 });
    expect(phone.tables[0].rows[0]).toMatchObject({ name: "Ana", cash: 500_000, finalCash: 300_000, currency: "USD", toRecord: "30 min" });
  });

  it("exports a member report with the team median in each figure", () => {
    const document = buildMemberDocument({
      profile: profiles[0],
      currency: "USD",
      sections: [{ role: "closer", figures: closerMemberFigures(ana, reports.closers.rows, "USD"), items: null, days: null }],
      period: "p",
      boundary: "b",
      generatedAt: 0,
    });
    expect(document.title).toBe("Member report · Ana");
    expect(document.summary.find((item) => item.label === "Phone closer · Show rate")?.value).toBe("75.0% (team median 87.5%)");
    expect(document.tables.at(-1)?.title).toBe("Definitions");
  });
});
