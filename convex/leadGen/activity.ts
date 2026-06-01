import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  deriveOverviewRange,
  overviewRangeValidator,
  toPublicOverviewRange,
} from "../dashboard/overviewRange";
import type { CrmRole } from "../lib/roleMapping";
import { requireTenantUser } from "../requireTenantUser";
import { summarizeDailyRows } from "./reportBuilders";
import { DAILY_STATS_READ_LIMIT } from "./reportLimits";
import { loadCurrentScheduledHoursByWorkerDay } from "./schedules";

export const listMyRecentSubmissions = query({
  args: {
    paginationOpts: paginationOptsValidator,
    range: v.optional(overviewRangeValidator),
  },
  handler: async (ctx, args) => {
    const access = await resolveOwnLeadGenWorker(ctx);
    if (!access) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const range = args.range ? deriveOverviewRange(args.range, Date.now()) : null;

    const page = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) =>
        range
          ? q
              .eq("tenantId", access.tenantId)
              .eq("workerId", access.workerId)
              .gte("submittedAt", range.slackWindowStart)
              .lt("submittedAt", range.slackWindowEnd)
          : q.eq("tenantId", access.tenantId).eq("workerId", access.workerId),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...page,
      page: await hydrateSubmissionProspects(ctx, access.tenantId, page.page),
    };
  },
});

export const getMyActivitySummary = query({
  args: { range: overviewRangeValidator },
  handler: async (ctx, { range }) => {
    const derivedRange = deriveOverviewRange(range, Date.now());
    const publicRange = toPublicOverviewRange(derivedRange);
    const access = await resolveOwnLeadGenWorker(ctx);
    if (!access) {
      return {
        range: publicRange,
        submissions: 0,
        scheduledHours: 0,
        leadsPerHour: null,
      };
    }

    const rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
        q
          .eq("tenantId", access.tenantId)
          .eq("workerId", access.workerId)
          .gte("dayKey", derivedRange.startBusinessDate)
          .lte("dayKey", derivedRange.endBusinessDateInclusive),
      )
      .take(DAILY_STATS_READ_LIMIT + 1);

    if (rows.length > DAILY_STATS_READ_LIMIT) {
      throw new Error("Lead Gen activity range is too large. Narrow the range.");
    }

    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, {
        tenantId: access.tenantId,
        rows,
      });
    const summary = summarizeDailyRows(rows, currentScheduledHoursByWorkerDay);

    return {
      range: publicRange,
      submissions: summary.submissions,
      scheduledHours: summary.scheduledHours,
      leadsPerHour: summary.leadsPerHour,
    };
  },
});

export const getMyDaySummary = query({
  args: { dayKey: v.string() },
  handler: async (ctx, { dayKey }) => {
    const access = await resolveOwnLeadGenWorker(ctx);
    if (!access) {
      return { submissions: 0, uniqueProspects: 0, duplicates: 0 };
    }

    const rows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
        q
          .eq("tenantId", access.tenantId)
          .eq("workerId", access.workerId)
          .eq("dayKey", dayKey),
      )
      .take(10);

    return rows.reduce(
      (acc, row) => ({
        submissions: acc.submissions + row.submissions,
        uniqueProspects: acc.uniqueProspects + row.uniqueProspectsSubmitted,
        duplicates: acc.duplicates + row.duplicateProspectSubmissions,
      }),
      { submissions: 0, uniqueProspects: 0, duplicates: 0 },
    );
  },
});

async function resolveOwnLeadGenWorker(ctx: QueryCtx) {
  const access = await requireTenantUser(ctx, [
    "lead_generator",
    "tenant_master",
    "tenant_admin",
  ]);

  const worker = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) =>
      q.eq("tenantId", access.tenantId).eq("userId", access.userId),
    )
    .unique();

  if (!worker) {
    return null;
  }
  if (!worker.isActive && access.role === "lead_generator") {
    return null;
  }

  return {
    tenantId: access.tenantId,
    userId: access.userId,
    role: access.role,
    workerId: worker._id,
  } satisfies {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    role: CrmRole;
    workerId: Id<"leadGenWorkers">;
  };
}

async function hydrateSubmissionProspects(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Doc<"leadGenSubmissions">[],
) {
  const prospects = new Map<Id<"leadGenProspects">, Doc<"leadGenProspects">>();

  for (const prospectId of new Set(rows.map((row) => row.prospectId))) {
    const prospect = await ctx.db.get(prospectId);
    if (prospect && prospect.tenantId === tenantId) {
      prospects.set(prospect._id, prospect);
    }
  }

  return rows.map((row) => ({
    ...row,
    prospect: prospects.get(row.prospectId) ?? null,
  }));
}
