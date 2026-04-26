import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { normalizeOpportunitySource, type OpportunitySource } from "../lib/sideDeals";
import { opportunityActivityKeys } from "../lib/opportunitySearch";
import { requireTenantUser } from "../requireTenantUser";
import {
  opportunitySourceValidator,
  opportunityStatusValidator,
  periodFilterValidator,
} from "./validators";

type OpportunityRow = Doc<"opportunities"> & {
  source: OpportunitySource;
  hasPendingStaleNudge: boolean;
  lead: {
    _id: Id<"leads">;
    fullName?: string;
    email: string;
    phone?: string;
    status: Doc<"leads">["status"];
  } | null;
  assignedCloser: {
    _id: Id<"users">;
    fullName?: string;
    email: string;
  } | null;
  latestActivityAt: number;
};

const SEARCH_CANDIDATE_LIMIT = 200;
const SEARCH_RESULT_LIMIT = 50;

async function hasPendingStaleNudge(
  ctx: QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<boolean> {
  const nudge = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q
        .eq("opportunityId", opportunityId)
        .eq("status", "pending")
        .eq("reason", "stale_opportunity_nudge"),
    )
    .first();

  return nudge !== null;
}

function resolvePeriod(
  periodFilter: "today" | "this_week" | "this_month" | undefined,
  nowMs = Date.now(),
): { periodStart?: number; periodEnd?: number } {
  if (!periodFilter) {
    return {};
  }

  const now = new Date(nowMs);
  const end = nowMs;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (periodFilter === "this_week") {
    start.setDate(start.getDate() - start.getDay());
  } else if (periodFilter === "this_month") {
    start.setDate(1);
  }

  return { periodStart: start.getTime(), periodEnd: end };
}

async function resolveEffectiveCloserId(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    viewerUserId: Id<"users">;
    isAdmin: boolean;
    closerFilter?: Id<"users">;
  },
): Promise<Id<"users"> | undefined> {
  if (!args.isAdmin) {
    return args.viewerUserId;
  }
  if (!args.closerFilter) {
    return undefined;
  }

  const closer = await ctx.db.get(args.closerFilter);
  if (
    !closer ||
    closer.tenantId !== args.tenantId ||
    closer.role !== "closer" ||
    closer.isActive === false
  ) {
    throw new Error("Invalid closer filter.");
  }
  return closer._id;
}

function buildOpportunityListQuery(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    closerId?: Id<"users">;
    status?: Doc<"opportunities">["status"];
    source?: OpportunitySource;
    periodStart?: number;
    periodEnd?: number;
  },
) {
  const hasPeriod =
    args.periodStart !== undefined && args.periodEnd !== undefined;

  if (args.closerId && args.source && args.status) {
    const closerId = args.closerId;
    const source = args.source;
    const status = args.status;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_assignedCloserId_source_status_latestActivityAt",
      (q) => {
        const query = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", closerId)
          .eq("source", source)
          .eq("status", status);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  if (args.closerId && args.source) {
    const closerId = args.closerId;
    const source = args.source;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_source_and_latestActivityAt",
      (q) => {
        const query = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", closerId)
          .eq("source", source);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  if (args.closerId && args.status) {
    const closerId = args.closerId;
    const status = args.status;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_status_and_latestActivityAt",
      (q) => {
        const query = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", closerId)
          .eq("status", status);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  if (args.closerId) {
    const closerId = args.closerId;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_assignedCloserId_and_latestActivityAt",
      (q) => {
        const query = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", closerId);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  if (args.source && args.status) {
    const source = args.source;
    const status = args.status;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_source_and_status_and_latestActivityAt",
      (q) => {
        const query = q
          .eq("tenantId", args.tenantId)
          .eq("source", source)
          .eq("status", status);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  if (args.source) {
    const source = args.source;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_source_and_latestActivityAt",
      (q) => {
        const query = q.eq("tenantId", args.tenantId).eq("source", source);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  if (args.status) {
    const status = args.status;
    return ctx.db.query("opportunities").withIndex(
      "by_tenantId_and_status_and_latestActivityAt",
      (q) => {
        const query = q.eq("tenantId", args.tenantId).eq("status", status);
        if (hasPeriod) {
          return query
            .gte("latestActivityAt", args.periodStart!)
            .lt("latestActivityAt", args.periodEnd!);
        }
        return query;
      },
    );
  }
  return ctx.db.query("opportunities").withIndex(
    "by_tenantId_and_latestActivityAt",
    (q) => {
      const query = q.eq("tenantId", args.tenantId);
      if (hasPeriod) {
        return query
          .gte("latestActivityAt", args.periodStart!)
          .lt("latestActivityAt", args.periodEnd!);
      }
      return query;
    },
  );
}

async function enrichOpportunityRows(
  ctx: QueryCtx,
  opportunities: Doc<"opportunities">[],
): Promise<OpportunityRow[]> {
  const leadIds = new Set<Id<"leads">>();
  const closerIds = new Set<Id<"users">>();

  for (const opportunity of opportunities) {
    leadIds.add(opportunity.leadId);
    if (opportunity.assignedCloserId) {
      closerIds.add(opportunity.assignedCloserId);
    }
  }

  const [leadEntries, closerEntries] = await Promise.all([
    Promise.all(
      [...leadIds].map(async (leadId) => ({
        leadId,
        lead: await ctx.db.get(leadId),
      })),
    ),
    Promise.all(
      [...closerIds].map(async (closerId) => ({
        closerId,
        closer: await ctx.db.get(closerId),
      })),
    ),
  ]);

  const leadsById = new Map(leadEntries.map(({ leadId, lead }) => [leadId, lead]));
  const closersById = new Map(
    closerEntries.map(({ closerId, closer }) => [closerId, closer]),
  );

  return await Promise.all(opportunities.map(async (opportunity) => {
    const lead = leadsById.get(opportunity.leadId) ?? null;
    const closer = opportunity.assignedCloserId
      ? closersById.get(opportunity.assignedCloserId) ?? null
      : null;

    return {
      ...opportunity,
      source: normalizeOpportunitySource(opportunity),
      hasPendingStaleNudge: await hasPendingStaleNudge(ctx, opportunity._id),
      latestActivityAt: opportunity.latestActivityAt ?? opportunity.updatedAt,
      lead: lead
        ? {
            _id: lead._id,
            fullName: lead.fullName,
            email: lead.email,
            phone: lead.phone,
            status: lead.status,
          }
        : null,
      assignedCloser:
        closer && closer.role === "closer"
          ? {
              _id: closer._id,
              fullName: closer.fullName,
              email: closer.email,
          }
        : null,
    };
  }));
}

export const listOpportunities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    sourceFilter: v.optional(opportunitySourceValidator),
    periodFilter: periodFilterValidator,
    closerFilter: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const closerId = await resolveEffectiveCloserId(ctx, {
      tenantId,
      viewerUserId: userId,
      isAdmin,
      closerFilter: args.closerFilter,
    });
    const { periodStart, periodEnd } = resolvePeriod(args.periodFilter);

    const result = await buildOpportunityListQuery(ctx, {
      tenantId,
      closerId,
      status: args.statusFilter,
      source: args.sourceFilter,
      periodStart,
      periodEnd,
    })
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await enrichOpportunityRows(ctx, result.page),
    };
  },
});

export const searchOpportunities = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(opportunityStatusValidator),
    sourceFilter: v.optional(opportunitySourceValidator),
    periodFilter: periodFilterValidator,
    closerFilter: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";
    const closerId = await resolveEffectiveCloserId(ctx, {
      tenantId,
      viewerUserId: userId,
      isAdmin,
      closerFilter: args.closerFilter,
    });
    const term = args.searchTerm.trim();
    if (term.length < 2) {
      return [];
    }

    const now = Date.now();
    const periodKeys = opportunityActivityKeys(now);
    const projectionMatches = await ctx.db
      .query("opportunitySearch")
      .withSearchIndex("search_opportunities", (q) => {
        let search = q.search("searchText", term).eq("tenantId", tenantId);
        if (args.sourceFilter) {
          search = search.eq("source", args.sourceFilter);
        }
        if (args.statusFilter) {
          search = search.eq("status", args.statusFilter);
        }
        if (closerId) {
          search = search.eq("assignedCloserId", closerId);
        }
        if (args.periodFilter === "today") {
          search = search.eq("activityDayKey", periodKeys.activityDayKey);
        } else if (args.periodFilter === "this_week") {
          search = search.eq("activityWeekKey", periodKeys.activityWeekKey);
        } else if (args.periodFilter === "this_month") {
          search = search.eq("activityMonthKey", periodKeys.activityMonthKey);
        }
        return search;
      })
      .take(SEARCH_CANDIDATE_LIMIT);

    const opportunities = await Promise.all(
      projectionMatches.map((match) => ctx.db.get(match.opportunityId)),
    );

    const { periodStart, periodEnd } = resolvePeriod(args.periodFilter, now);
    const filtered = opportunities.filter((opportunity): opportunity is Doc<"opportunities"> => {
      if (!opportunity || opportunity.tenantId !== tenantId) {
        return false;
      }
      if (closerId && opportunity.assignedCloserId !== closerId) {
        return false;
      }
      if (args.statusFilter && opportunity.status !== args.statusFilter) {
        return false;
      }
      if (
        args.sourceFilter &&
        normalizeOpportunitySource(opportunity) !== args.sourceFilter
      ) {
        return false;
      }
      const activity = opportunity.latestActivityAt ?? opportunity.updatedAt;
      if (periodStart !== undefined && activity < periodStart) {
        return false;
      }
      if (periodEnd !== undefined && activity >= periodEnd) {
        return false;
      }
      return true;
    });

    filtered.sort(
      (a, b) =>
        (b.latestActivityAt ?? b.updatedAt) - (a.latestActivityAt ?? a.updatedAt),
    );

    return await enrichOpportunityRows(ctx, filtered.slice(0, SEARCH_RESULT_LIMIT));
  },
});
