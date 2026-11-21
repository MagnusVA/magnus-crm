import type { AnyReportDefinition, ReportDefinition } from "../definition";
import { num, rangeParams, str } from "../definition";

/**
 * Lead countries: the people with a Slack qualification submitted in the
 * range, counted once each under their country. A person's country is the
 * one on their profile (`leads.country`, which the Slack form sets), else the
 * country typed on their newest qualification in the range. Countries are
 * free text, so they group ignoring case and repeated spaces only. Read by
 * the admin `magnus_lead_countries` tool, always from ClickHouse, as of the
 * last sync.
 */
export const LEAD_COUNTRIES_REPORT = "lead_countries.summary";

/** Slack's country field takes at most 100 characters. */
export const MAX_COUNTRY_LENGTH = 100;
/** Leads listed for one country; one more is read to tell that more exist. */
export const LEAD_COUNTRY_LIST_LIMIT = 100;
/** Distinct countries returned; free text, so bounded. */
export const LEAD_COUNTRY_GROUP_LIMIT = 500;

export type LeadCountriesFilters = { country: string | null };

export type LeadCountriesAnswer = {
  totals: { leads: number; withCountry: number; withoutCountry: number };
  /** Most leads first. Leads without a country are only in `totals`. */
  countries: Array<{ country: string; leads: number }>;
  /** Only when `country` is filtered: its leads, newest qualification first. */
  leads: Array<{ leadId: string; name: string | null; country: string; lastQualifiedAt: number }>;
  /** Every lead with the filtered country, listed or not. */
  leadsTotal: number;
  partial: boolean;
};

/**
 * Whitespace runs: JavaScript's `\s` with the `u` flag, and the same set in
 * ClickHouse's RE2, whose `\s` leaves out vertical tab, U+FEFF and the
 * Unicode spaces.
 */
const WHITESPACE = "[\\s\\p{Z}]+";
const WHITESPACE_RE2 = "[\\s\\v\\x{FEFF}\\p{Z}]+";

/** Trimmed, with each run of spaces as one space: how a country is shown. */
export function displayCountry(value: string | null | undefined): string {
  return (value ?? "").replace(new RegExp(WHITESPACE, "gu"), " ").trim();
}

/** What countries group by. ClickHouse's `lowerUTF8` and this agree on letters. */
export function countryKey(value: string | null | undefined): string {
  return displayCountry(value).toLowerCase();
}

/** Same rules as `displayCountry`, in SQL. `{whitespace:String}` is `WHITESPACE_RE2`. */
const displaySql = (expr: string) => `trimBoth(replaceRegexpAll(ifNull(${expr}, ''), {whitespace:String}, ' '))`;

// One row per surviving person qualified in the range. Merges normally repoint
// events to the survivor; a one-hop pointer left behind is followed too.
const cohortSql = `
WITH
resolved AS (
  SELECT id AS observed_id, if(ifNull(merged_into_lead_id, '') = '', id, merged_into_lead_id) AS lead_id
  FROM analytics.people
  WHERE tenant_id = {tenant_id:String}
),
qualified AS (
  SELECT r.lead_id AS lead_id,
    max(q.submitted_at_ms) AS last_qualified_at_ms,
    -- A newest event without a country wins too: argMax skips NULLs.
    argMax(ifNull(q.country_snapshot, ''), (q.submitted_at_ms, q.creation_time_ms, q.id)) AS latest_snapshot
  FROM (
    SELECT id, lead_id, submitted_at_ms, creation_time_ms, country_snapshot
    FROM analytics.qualifications
    WHERE tenant_id = {tenant_id:String}
      AND submitted_at_ms >= {from_ms:Int64}
      AND submitted_at_ms < {to_ms:Int64}
      AND lead_id IS NOT NULL
  ) AS q
  INNER JOIN resolved AS r ON r.observed_id = q.lead_id
  GROUP BY r.lead_id
),
cohort AS (
  SELECT p.id AS lead_id, p.full_name AS full_name, q.last_qualified_at_ms AS last_qualified_at_ms,
    if(${displaySql("p.country")} = '', ${displaySql("q.latest_snapshot")}, ${displaySql("p.country")}) AS country
  FROM qualified AS q
  INNER JOIN (
    SELECT id, full_name, country
    FROM analytics.people
    WHERE tenant_id = {tenant_id:String}
      AND ifNull(status, '') != 'merged'
      AND ifNull(merged_into_lead_id, '') = ''
  ) AS p ON p.id = q.lead_id
)`;

const countriesSql = `${cohortSql}
SELECT lowerUTF8(country) AS country_key, min(country) AS country_label, count() AS leads
FROM cohort
GROUP BY country_key
ORDER BY country_key = '' DESC, leads DESC, country_key ASC
LIMIT {group_limit:UInt32}`;

const leadsSql = `${cohortSql}
SELECT lead_id, full_name, country, last_qualified_at_ms, count() OVER () AS matches
FROM cohort
WHERE lowerUTF8(country) = {country_key:String}
ORDER BY last_qualified_at_ms DESC, lead_id ASC
LIMIT {list_limit:UInt32}`;

type CountryRow = { key: string; country: string; leads: number };
type LeadRow = LeadCountriesAnswer["leads"][number];

/**
 * The answer from grouped countries and the listed leads. Both sources pass
 * their rows here: ClickHouse's grouped rows, or the live reader's.
 * `groupsComplete` is false when the group list was cut at its limit.
 */
export function buildLeadCountries(input: {
  groups: CountryRow[];
  groupsComplete: boolean;
  leads: LeadRow[];
  leadsTotal: number;
  filtered: boolean;
  partial: boolean;
}): LeadCountriesAnswer {
  const withoutCountry = input.groups.find(group => group.key === "")?.leads ?? 0;
  const named = input.groups
    .filter(group => group.key !== "")
    .sort((a, b) => b.leads - a.leads || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Totals count every group read, before the list is cut.
  const withCountry = named.reduce((sum, row) => sum + row.leads, 0);
  const countries = named.slice(0, LEAD_COUNTRY_GROUP_LIMIT).map(group => ({ country: group.country, leads: group.leads }));
  const leads = input.filtered ? input.leads.slice(0, LEAD_COUNTRY_LIST_LIMIT) : [];
  return {
    totals: { leads: withCountry + withoutCountry, withCountry, withoutCountry },
    countries,
    leads,
    leadsTotal: input.filtered ? input.leadsTotal : 0,
    partial: input.partial || !input.groupsComplete || named.length > LEAD_COUNTRY_GROUP_LIMIT || (input.filtered && input.leads.length > LEAD_COUNTRY_LIST_LIMIT),
  };
}

const definition: ReportDefinition<LeadCountriesFilters, LeadCountriesAnswer> = {
  id: LEAD_COUNTRIES_REPORT,
  page: null,
  roles: ["tenant_master", "tenant_admin"],
  day: "business",
  parseFilters: async (_ctx, raw) => {
    if (raw.country === undefined || raw.country === null) return { country: null };
    if (typeof raw.country !== "string") throw new Error("Invalid filter.");
    const key = countryKey(raw.country);
    if (!key || key.length > MAX_COUNTRY_LENGTH) throw new Error(`Choose a country of 1 to ${MAX_COUNTRY_LENGTH} characters.`);
    return { country: key };
  },
  sql: (input) => ({
    // The no-country group sorts first, so the limit never cuts it; the
    // limit is past the cap, so a cut list is detectable.
    countries: { sql: countriesSql, params: { ...rangeParams(input.range), whitespace: WHITESPACE_RE2, group_limit: LEAD_COUNTRY_GROUP_LIMIT + 2 } },
    ...(input.filters.country !== null
      ? { leads: { sql: leadsSql, params: { ...rangeParams(input.range), whitespace: WHITESPACE_RE2, country_key: input.filters.country, list_limit: LEAD_COUNTRY_LIST_LIMIT + 1 } } }
      : {}),
  }),
  finalize: async (_ctx, input) => {
    const groups = (input.rows.countries ?? []).map(row => ({ key: String(row.country_key ?? ""), country: String(row.country_label ?? ""), leads: num(row.leads) }));
    return buildLeadCountries({
      groups,
      // Up to 500 named countries plus the no-country group fit in 502 rows.
      groupsComplete: groups.length <= LEAD_COUNTRY_GROUP_LIMIT + 1,
      leads: (input.rows.leads ?? []).map(row => ({
        leadId: String(row.lead_id),
        name: str(row.full_name),
        country: String(row.country ?? ""),
        lastQualifiedAt: num(row.last_qualified_at_ms),
      })),
      leadsTotal: num(input.rows.leads?.[0]?.matches),
      filtered: input.filters.country !== null,
      partial: false,
    });
  },
  live: {
    name: "reports/leadCountries:liveLeadCountries",
    args: (input) => ({
      tenantId: input.tenantId,
      fromMs: input.range.fromMs,
      toMs: input.range.toMs,
      country: input.filters.country,
    }),
  },
};

export const leadCountriesReports = [definition as unknown as AnyReportDefinition];
