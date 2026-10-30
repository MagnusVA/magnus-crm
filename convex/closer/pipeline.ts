import { v } from "convex/values";
import { literals } from "convex-helpers/validators";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { dealLabelOf } from "../opportunities/stageLabels";
import { DEAL_POSITIONS } from "../opportunities/stages";
import { CLOSER_LOOKUP_TABS, type CloserLookupTab } from "./pipelineTabs";
import {
  dealLastActivityAt,
  dealNextStepValidator,
  dealProgramKey,
  loadDealNextStep,
  loadPrograms,
  NO_PROGRAM,
  personNameOf,
  programFallbackNames,
  readCloserDeals,
  sumByCurrency,
} from "./pipelineDeals";

// My Pipeline's lookup, "All deals": every deal the closer owns, by outcome
// tab, program and person, the last active first
// (.impeccable/surfaces/app-workspace-closer-pipeline-page-tsx.md).

// The rows one call returns at most; the client asks for more in steps.
const MAX_LOOKUP_ROWS = 300;
// The search matches read; a search past it says so.
const SEARCH_MATCH_LIMIT = 200;
// Far above the payments one deal has.
const DEAL_PAYMENT_SCAN = 50;

const tabValidator = literals(...CLOSER_LOOKUP_TABS);

function inTab(deal: Doc<"opportunities">, tab: CloserLookupTab): boolean {
  return tab === "all" || deal.outcome === tab;
}

/**
 * The closer's deals for the lookup, sorted by last activity, newest first.
 *
 * Reads the closer's deals once, bounded (`readCloserDeals`), and filters
 * them by `programKey` (a tenantPrograms id, or "none") and by `search`,
 * matched through the deal search index on the closer's deals. `counts` are
 * each tab's deals under the program and search; `programs` lists every
 * program the closer has deals in, for the filter. Returns the first `limit`
 * rows of the tab (at most MAX_LOOKUP_ROWS), each with its person, program,
 * stage, last activity, next step (open deals) and what was paid on it by
 * currency, disputed payments left out.
 *
 * `isPartial` says the closer has more deals than the read covers, so the
 * oldest are missing; `isSearchPartial` that the search had more matches
 * than it read.
 */
export const listMyOpportunities = query({
  args: {
    tab: tabValidator,
    programKey: v.optional(v.string()),
    search: v.optional(v.string()),
    limit: v.number(),
  },
  returns: v.object({
    rows: v.array(
      v.object({
        opportunityId: v.id("opportunities"),
        leadId: v.id("leads"),
        personName: v.string(),
        programKey: v.string(),
        programName: v.union(v.string(), v.null()),
        position: literals(...DEAL_POSITIONS),
        systemLoss: v.union(v.null(), literals("stale", "no_show", "canceled")),
        lastActivityAt: v.number(),
        nextStep: v.union(v.null(), dealNextStepValidator),
        paid: v.array(v.object({ currency: v.string(), amountMinor: v.number() })),
      }),
    ),
    counts: v.object({ all: v.number(), open: v.number(), won: v.number(), lost: v.number() }),
    programs: v.array(
      v.object({
        programKey: v.string(),
        programName: v.union(v.string(), v.null()),
        deals: v.number(),
      }),
    ),
    matched: v.number(),
    isPartial: v.boolean(),
    isSearchPartial: v.boolean(),
  }),
  handler: async (ctx, { tab, programKey, search, limit }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const { deals, capped } = await readCloserDeals(ctx, tenantId, userId);

    // The programs for the filter, from every deal the read covers.
    const dealsByProgram = new Map<string, number>();
    for (const deal of deals) {
      const key = dealProgramKey(deal);
      dealsByProgram.set(key, (dealsByProgram.get(key) ?? 0) + 1);
    }
    const programInfo = await loadPrograms(ctx, tenantId, programFallbackNames(deals));
    const programName = (key: string) =>
      key === NO_PROGRAM ? null : (programInfo.get(key)?.name ?? null);

    const term = search?.trim() ?? "";
    let matches: Set<Id<"opportunities">> | null = null;
    let isSearchPartial = false;
    if (term !== "") {
      const found = await ctx.db
        .query("opportunitySearch")
        .withSearchIndex("search_opportunities", (q) =>
          q.search("searchText", term).eq("tenantId", tenantId).eq("assignedCloserId", userId),
        )
        .take(SEARCH_MATCH_LIMIT);
      matches = new Set(found.map((row) => row.opportunityId));
      isSearchPartial = found.length === SEARCH_MATCH_LIMIT;
    }

    const filtered = deals.filter(
      (deal) =>
        (programKey === undefined || dealProgramKey(deal) === programKey) &&
        (matches === null || matches.has(deal._id)),
    );
    const counts = { all: filtered.length, open: 0, won: 0, lost: 0 };
    for (const deal of filtered) counts[deal.outcome] += 1;

    const inThisTab = filtered
      .filter((deal) => inTab(deal, tab))
      .sort((a, b) => dealLastActivityAt(b) - dealLastActivityAt(a));
    const shown = inThisTab.slice(0, Math.max(1, Math.min(Math.floor(limit), MAX_LOOKUP_ROWS)));

    const rows = await Promise.all(
      shown.map(async (deal) => {
        const label = dealLabelOf(deal);
        const [lead, nextStep, payments] = await Promise.all([
          ctx.db.get("leads", deal.leadId),
          deal.outcome === "open" ? loadDealNextStep(ctx, deal) : Promise.resolve(null),
          ctx.db
            .query("paymentRecords")
            .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", deal._id))
            .take(DEAL_PAYMENT_SCAN),
        ]);
        const key = dealProgramKey(deal);
        return {
          opportunityId: deal._id,
          leadId: deal.leadId,
          personName: personNameOf(lead && lead.tenantId === tenantId ? lead : null),
          programKey: key,
          programName: programName(key),
          position: label.position,
          systemLoss: label.systemLoss,
          lastActivityAt: dealLastActivityAt(deal),
          nextStep,
          paid: sumByCurrency(
            payments.filter((payment) => payment.tenantId === tenantId && payment.status !== "disputed"),
          ).map(({ currency, amountMinor }) => ({ currency, amountMinor })),
        };
      }),
    );

    return {
      rows,
      counts,
      programs: [...dealsByProgram].map(([key, count]) => ({
        programKey: key,
        programName: programName(key),
        deals: count,
      })),
      matched: inThisTab.length,
      isPartial: capped,
      isSearchPartial,
    };
  },
});
