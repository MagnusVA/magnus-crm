import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import {
  LEAD_COUNTRY_GROUP_LIMIT,
  LEAD_COUNTRY_LIST_LIMIT,
  buildLeadCountries,
  countryKey,
  displayCountry,
} from "../analytics/definitions/leadCountries";

/** Qualifications read live; past this the answer is marked partial. */
const LIVE_EVENT_LIMIT = 2000;

/**
 * The lead-countries report read from Convex, for `pnpm analytics:parity`
 * only: the admin tool always reads ClickHouse. Same cohort and grouping as
 * the SQL in `analytics/definitions/leadCountries.ts`.
 */
export const liveLeadCountries = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    fromMs: v.number(),
    toMs: v.number(),
    country: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, { tenantId, fromMs, toMs, country }) => {
    const events = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q.eq("tenantId", tenantId).gte("submittedAt", fromMs).lt("submittedAt", toMs),
      )
      .take(LIVE_EVENT_LIMIT + 1);
    const partial = events.length > LIVE_EVENT_LIMIT;
    const leads = new Map<Id<"leads">, Doc<"leads"> | null>();
    const load = async (id: Id<"leads">) => {
      if (!leads.has(id)) {
        const lead = await ctx.db.get("leads", id);
        leads.set(id, lead?.tenantId === tenantId ? lead : null);
      }
      return leads.get(id)!;
    };
    type Latest = { at: number; created: number; id: string; snapshot: string | undefined };
    const cohort = new Map<Id<"leads">, { lead: Doc<"leads">; lastAt: number; latest: Latest }>();
    for (const event of events.slice(0, LIVE_EVENT_LIMIT)) {
      if (!event.leadId) continue;
      const observed = await load(event.leadId);
      if (!observed) continue;
      const survivor = observed.mergedIntoLeadId ? await load(observed.mergedIntoLeadId) : observed;
      if (!survivor || survivor.status === "merged" || survivor.mergedIntoLeadId) continue;
      const order: Latest = { at: event.submittedAt, created: event._creationTime, id: event._id, snapshot: event.countrySnapshot };
      const entry = cohort.get(survivor._id);
      const newer = (a: Latest, b: Latest) =>
        a.at !== b.at ? a.at > b.at : a.created !== b.created ? a.created > b.created : a.id > b.id;
      if (!entry) cohort.set(survivor._id, { lead: survivor, lastAt: event.submittedAt, latest: order });
      else {
        entry.lastAt = Math.max(entry.lastAt, event.submittedAt);
        if (newer(order, entry.latest)) entry.latest = order;
      }
    }
    const people = [...cohort.values()].map(({ lead, lastAt, latest }) => {
      const own = displayCountry(lead.country);
      return { leadId: lead._id, name: lead.fullName ?? null, country: own || displayCountry(latest.snapshot), lastQualifiedAt: lastAt };
    });
    const groups = new Map<string, { key: string; country: string; leads: number }>();
    for (const person of people) {
      const key = countryKey(person.country);
      const group = groups.get(key) ?? { key, country: person.country, leads: 0 };
      group.leads += 1;
      if (person.country < group.country) group.country = person.country;
      groups.set(key, group);
    }
    const matching = country === null ? [] : people
      .filter((person) => countryKey(person.country) === country)
      .sort((a, b) => b.lastQualifiedAt - a.lastQualifiedAt || (a.leadId < b.leadId ? -1 : 1));
    return JSON.stringify(buildLeadCountries({
      groups: [...groups.values()],
      groupsComplete: groups.size <= LEAD_COUNTRY_GROUP_LIMIT + 1,
      leads: matching.slice(0, LEAD_COUNTRY_LIST_LIMIT + 1),
      leadsTotal: matching.length,
      filtered: country !== null,
      partial,
    }));
  },
});
