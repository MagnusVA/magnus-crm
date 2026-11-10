import type { AttributionLanes, AttributionPaths } from "../../../convex/reports/attribution";
import type { ReportDocument, ReportRecord } from "../../operations-reports/document";
import { REPORT_TERMS } from "../definitions";
import { definitionsTable } from "../export";
import { formatMoney, formatRatio, inCurrency } from "./money";

// The Attribution page's shaping (docs/reviews/reports-overhaul.html §11).
// Each role is a lane worth the range's cash: the cash on deals someone in
// that role is credited on, plus the cash no one in it touched. People's
// rows count each payment in full for every person credited, so they add up
// to the lane plus Shared. Attribution records who contributed, never
// commission or what anyone is owed.

export type CreditRole = AttributionLanes["lanes"][number]["role"];
export type Lane = AttributionLanes["lanes"][number];
export type LanePerson = Lane["people"][number];

/** The roles in chain order: who found the person, qualified, booked and closed. */
export const ROLE_ORDER: readonly CreditRole[] = ["lead_gen", "setter", "dm_team", "dm_closer", "closer"];

export const ROLE_LABELS: Record<CreditRole, string> = {
  lead_gen: "Lead gen",
  setter: "Setter",
  dm_team: "DM team",
  dm_closer: "DM closer",
  closer: "Closer",
};

/** What a credit row's source was, in words. */
export const SOURCE_LABELS: Record<string, string> = {
  capture: "Captured the person",
  respark: "Resparked the person",
  slack_qualification: "Qualified in Slack",
  booking_utm: "Booking link",
  booking_closer: "Booked with them",
  reassignment: "Reassigned to them",
  side_deal: "Named on the side deal",
};

export const NOT_LINKED = "Not linked to a member";

/** Coverage as a percent with one decimal, or a dash when there is no cash to cover. */
export function formatCoverage(coverage: number | null | undefined) {
  return formatRatio(coverage);
}

export type LaneView = {
  role: CreditRole;
  /** The range's cash in this currency: every lane is worth this much. */
  totalMinor: number;
  /** Cash with at least one credit in the role. */
  laneMinor: number;
  /** Cash counted for two or more people in the role. */
  sharedMinor: number;
  /** Cash no one in the role is credited on. */
  uncreditedMinor: number;
  coverage: number | null;
  /** Each credited person's cash in this currency, largest first. */
  people: Array<LanePerson & { amountMinor: number }>;
  /** The people's rows added up: the lane plus Shared. */
  peopleMinor: number;
};

function lanesInOrder(lanes: AttributionLanes) {
  return ROLE_ORDER.map((role) => lanes.lanes.find((lane) => lane.role === role)).filter(
    (lane): lane is Lane => lane !== undefined,
  );
}

/** One role's lane in one currency. */
export function laneView(data: AttributionLanes, lane: Lane, currency: string): LaneView {
  const totalMinor = inCurrency(data.totals, currency)?.cashMinor ?? 0;
  const money = inCurrency(lane.byCurrency, currency);
  const laneMinor = money?.laneMinor ?? 0;
  const uncredited = data.uncreditedByRole.find((row) => row.role === lane.role);
  const people = lane.people
    .map((person) => ({ ...person, amountMinor: inCurrency(person.byCurrency, currency)?.amountMinor ?? 0 }))
    .filter((person) => person.amountMinor !== 0)
    .sort((a, b) => b.amountMinor - a.amountMinor || a.name.localeCompare(b.name));
  return {
    role: lane.role,
    totalMinor,
    laneMinor,
    sharedMinor: money?.sharedMinor ?? 0,
    uncreditedMinor: inCurrency(uncredited?.byCurrency, currency)?.amountMinor ?? totalMinor - laneMinor,
    coverage: money?.coverage ?? (totalMinor !== 0 ? laneMinor / totalMinor : null),
    people,
    peopleMinor: people.reduce((sum, person) => sum + person.amountMinor, 0),
  };
}

/** Every lane in chain order, in one currency. */
export function laneViews(data: AttributionLanes, currency: string): LaneView[] {
  return lanesInOrder(data).map((lane) => laneView(data, lane, currency));
}

export type ResponsibleRow = LanePerson & { rowKey: string; role: CreditRole; amountMinor: number };

/** Every credited person across the roles, by credited cash in one currency. */
export function responsibleRows(data: AttributionLanes, currency: string): ResponsibleRow[] {
  return lanesInOrder(data)
    .flatMap((lane) =>
      lane.people.map((person) => ({
        ...person,
        rowKey: `${lane.role}:${person.key}`,
        role: lane.role,
        amountMinor: inCurrency(person.byCurrency, currency)?.amountMinor ?? 0,
      })),
    )
    .sort(
      (a, b) =>
        b.amountMinor - a.amountMinor ||
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
        a.name.localeCompare(b.name),
    );
}

/** "Lead gen → Setter → Closer", or what a path with no credit at all means. */
export function pathLabel(roles: readonly CreditRole[]) {
  return roles.length === 0 ? "No credit in any role" : [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)).map((role) => ROLE_LABELS[role]).join(" → ");
}

export type PathRow = AttributionPaths["paths"][number] & { amountMinor: number };

/** The paths that paid in one currency, most cash first. */
export function pathRows(data: AttributionPaths, currency: string): PathRow[] {
  return data.paths
    .map((path) => ({ ...path, amountMinor: inCurrency(path.byCurrency, currency)?.amountMinor ?? 0 }))
    .filter((path) => path.amountMinor !== 0 || path.byCurrency.length === 0)
    .sort((a, b) => b.amountMinor - a.amountMinor || b.dealIds.length - a.dealIds.length || a.key.localeCompare(b.key));
}

/** A deal named only by its id: its last six characters, enough to tell deals apart. */
export function shortDealId(id: string) {
  return `Deal …${id.slice(-6)}`;
}

/**
 * Each deal's button label: its person's name, with the end of the deal's id
 * after it when two deals in the list share a name. A deal without a name
 * (still loading, or not found) keeps its short id.
 */
export function dealLabels(dealIds: readonly string[], names: ReadonlyMap<string, string> | undefined) {
  const counts = new Map<string, number>();
  for (const id of dealIds) {
    const name = names?.get(id);
    if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(dealIds.map((id) => {
    const name = names?.get(id);
    if (name === undefined) return [id, shortDealId(id)];
    return [id, (counts.get(name) ?? 0) > 1 ? `${name} · …${id.slice(-6)}` : name];
  }));
}

/** The currency the page opens on: the one with the most payments. */
export function attributionCurrencyWeights(data: AttributionLanes | undefined) {
  return (data?.totals ?? []).map((total) => ({ currency: total.currency, weight: total.payments }));
}

const money = (key: string, label: string) => ({ key, label, format: "money" as const, currencyKey: "currency" });

/**
 * The page as a document: coverage per role and currency as the summary,
 * then the lanes, every credited person and the paths, each currency in its
 * own rows, and the definitions.
 */
export function buildAttributionDocument(input: {
  words: string;
  dayLine: string;
  generatedAt: number;
  lanes: AttributionLanes;
  paths: AttributionPaths;
}): ReportDocument {
  const { lanes, paths } = input;
  const summary: ReportDocument["summary"] = [];
  for (const total of lanes.totals) {
    summary.push({ label: `${REPORT_TERMS.cash.label} (${total.currency})`, value: formatMoney(total.cashMinor, total.currency) });
    for (const view of laneViews(lanes, total.currency)) {
      summary.push({ label: `${ROLE_LABELS[view.role]} coverage (${total.currency})`, value: formatCoverage(view.coverage) });
    }
  }
  const tables: ReportDocument["tables"] = [
    {
      title: "Cash by role",
      columns: [
        { key: "role", label: "Role" },
        { key: "currency", label: "Currency" },
        money("total", REPORT_TERMS.cash.label),
        money("lane", "Cash with a credit"),
        money("shared", REPORT_TERMS.shared.label),
        money("uncredited", "No credit in this role"),
        { key: "coverage", label: REPORT_TERMS.attributionCoverage.label, format: "percent" },
      ],
      rows: lanes.totals.flatMap((total) =>
        laneViews(lanes, total.currency).map((view) => ({
          role: ROLE_LABELS[view.role],
          currency: total.currency,
          total: view.totalMinor,
          lane: view.laneMinor,
          shared: view.sharedMinor,
          uncredited: view.uncreditedMinor,
          coverage: view.coverage,
        })),
      ),
    },
    {
      title: "Who is responsible",
      columns: [
        { key: "role", label: "Role" },
        { key: "name", label: "Name" },
        { key: "member", label: "Member" },
        { key: "deals", label: "Deals", format: "number" },
        { key: "currency", label: "Currency" },
        money("credited", REPORT_TERMS.creditedCash.label),
      ],
      rows: lanesInOrder(lanes).flatMap((lane) =>
        lane.people.flatMap((person): ReportRecord[] =>
          person.byCurrency.map((row) => ({
            role: ROLE_LABELS[lane.role],
            name: person.name,
            member: person.linked ? "Linked" : NOT_LINKED,
            deals: person.dealIds.length,
            currency: row.currency,
            credited: row.amountMinor,
          })),
        ),
      ),
    },
    {
      title: "Paths that paid",
      columns: [
        { key: "path", label: "Roles credited" },
        { key: "deals", label: "Deals", format: "number" },
        { key: "currency", label: "Currency" },
        money("cash", REPORT_TERMS.cash.label),
      ],
      rows: paths.paths.flatMap((path) =>
        path.byCurrency.map((row) => ({
          path: pathLabel(path.roles),
          deals: path.dealIds.length,
          currency: row.currency,
          cash: row.amountMinor,
        })),
      ),
    },
    definitionsTable(["cash", "creditedCash", "shared", "attributionCoverage"]),
  ];
  return {
    title: "Attribution",
    period: input.words,
    generatedAt: input.generatedAt,
    boundary: `${input.dayLine} · Cash by payment date, credit as of each payment`,
    filters: "Attribution is a history of who contributed to each deal, never commission or what anyone is owed.",
    summary,
    tables,
  };
}
