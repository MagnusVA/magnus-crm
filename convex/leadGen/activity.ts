import { assertLeadGenBusinessDayReady } from "../lib/businessDayRebuildState";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  mergedStream,
  QueryStream,
  stream,
  type IndexBounds,
} from "convex-helpers/server/stream";
import schema from "../schema";
import { LIVE_QUERY_BYTE_BUDGET } from "../lib/liveQueryBounds";
import { countWorkerResparkResults } from "./resparkReports";
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
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { summarizeDailyRows } from "./reportBuilders";
import { DAILY_STATS_READ_LIMIT } from "./reportLimits";
import { loadCurrentScheduledHoursByWorkerDay } from "./schedules";

const LEAD_GEN_ACTIVITY_ROLES: CrmRole[] = [
  "lead_generator",
  "tenant_master",
  "tenant_admin",
];

export const listMyRecentSubmissions = query({
  args: {
    paginationOpts: paginationOptsValidator,
    range: v.optional(overviewRangeValidator),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantUser(ctx, LEAD_GEN_ACTIVITY_ROLES);
    const access = await resolveOwnLeadGenWorker(ctx, auth);
    if (!access) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const range = args.range
      ? deriveOverviewRange(
          args.range,
          Date.now(),
          await getTenantBusinessDay(ctx, auth.tenantId),
        )
      : null;

    const database = stream(ctx.db, schema);
    const captures = database
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
      .map(
        async (row): Promise<ActivityRow> => ({
          _id: row._id,
          submittedAt: row.submittedAt,
          type: "Capture",
          source: row.source,
          originKind: row.originKind,
          originValue: row.originValue,
          prospectId: row.prospectId,
        }),
      );
    const resparks = database
      .query("resparkBatchItems")
      .withIndex("by_tenantId_and_workerId_and_workedAt", (q) =>
        range
          ? q
              .eq("tenantId", access.tenantId)
              .eq("workerId", access.workerId)
              .gte("workedAt", range.slackWindowStart)
              .lt("workedAt", range.slackWindowEnd)
          : q
              .eq("tenantId", access.tenantId)
              .eq("workerId", access.workerId)
              .gt("workedAt", 0),
      )
      .order("desc")
      .map(async (row): Promise<ActivityRow | null> => {
        if (row.result !== "resparked" && row.result !== "not_a_fit")
          return null;
        return {
          _id: row._id,
          submittedAt: row.workedAt!,
          type:
            row.result === "resparked"
              ? "Respark · resparked"
              : "Respark · not a fit",
          source: "respark",
          originKind: "respark",
          originValue: BUCKET_LABELS[row.bucket],
          leadId: row.leadId,
        };
      });
    const page = await mergedStream(
      [new ActivityTimeStream(captures), new ActivityTimeStream(resparks)],
      ["activityAt", "_creationTime"],
    ).paginate({
      ...args.paginationOpts,
      maximumRowsRead: 1_000,
      maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
    });
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (row) => {
          const person = row.leadId
            ? await ctx.db.get("leads", row.leadId)
            : row.prospectId
              ? await ctx.db.get("leadGenProspects", row.prospectId)
              : null;
          return {
            ...row,
            prospect:
              person?.tenantId === access.tenantId
                ? {
                    normalizedHandle:
                      "normalizedHandle" in person
                        ? person.normalizedHandle
                        : person.socialHandles?.find(
                            (handle) => handle.type === "instagram",
                          )?.handle,
                  }
                : null,
          };
        }),
      ),
    };
  },
});

export const getMyActivitySummary = query({
  args: { range: overviewRangeValidator },
  handler: async (ctx, { range }) => {
    const auth = await requireTenantUser(ctx, LEAD_GEN_ACTIVITY_ROLES);
    await assertLeadGenBusinessDayReady(ctx, auth.tenantId);
    const derivedRange = deriveOverviewRange(
      range,
      Date.now(),
      await getTenantBusinessDay(ctx, auth.tenantId),
    );
    const publicRange = toPublicOverviewRange(derivedRange);
    const access = await resolveOwnLeadGenWorker(ctx, auth);
    if (!access) {
      return {
        range: publicRange,
        submissions: 0,
        resparks: 0,
        entries: 0,
        notAFit: 0,
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
      throw new Error(
        "Lead Gen activity range is too large. Narrow the range.",
      );
    }

    const currentScheduledHoursByWorkerDay =
      await loadCurrentScheduledHoursByWorkerDay(ctx, {
        tenantId: access.tenantId,
        rows,
      });
    const summary = summarizeDailyRows(rows, currentScheduledHoursByWorkerDay);

    const counts = await countWorkerResparkResults(
      ctx,
      access.tenantId,
      [access.workerId],
      derivedRange.slackWindowStart,
      derivedRange.slackWindowEnd,
    );
    const { resparks, notAFit } = counts.get(access.workerId)!;
    return {
      range: publicRange,
      submissions: summary.submissions,
      resparks,
      notAFit,
      entries: summary.submissions + resparks,
      scheduledHours: summary.scheduledHours,
      leadsPerHour: summary.leadsPerHour,
    };
  },
});

export const getMyDaySummary = query({
  args: { dayKey: v.string() },
  handler: async (ctx, { dayKey }) => {
    const auth = await requireTenantUser(ctx, LEAD_GEN_ACTIVITY_ROLES);
    await assertLeadGenBusinessDayReady(ctx, auth.tenantId);
    const access = await resolveOwnLeadGenWorker(ctx, auth);
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

async function resolveOwnLeadGenWorker(
  ctx: QueryCtx,
  access: TenantUserResult,
) {
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

const BUCKET_LABELS: Record<number, string> = {
  1: "1 Qualified, never booked",
  2: "2 Never qualified",
  3: "3 Inactive",
  4: "4 Had a call, deal lost",
  5: "5 Not a fit",
} as const;

type ActivityRow = {
  _id: string;
  submittedAt: number;
  type: "Capture" | "Respark · resparked" | "Respark · not a fit";
  source: Doc<"leadGenSubmissions">["source"] | "respark";
  originKind: string;
  originValue?: string;
  prospectId?: Id<"leadGenProspects">;
  leadId?: Id<"leads">;
};

/** The two indexes have the same key shape, with different timestamp names.
 * Rename only that field for the merge; keys, bounds and cursors stay intact.
 */
class ActivityTimeStream extends QueryStream<ActivityRow> {
  constructor(private readonly source: QueryStream<ActivityRow>) {
    super();
  }
  getOrder() {
    return this.source.getOrder();
  }
  getIndexFields() {
    return this.source
      .getIndexFields()
      .map((field) =>
        field === "workedAt" || field === "submittedAt" ? "activityAt" : field,
      );
  }
  getEqualityIndexFilter() {
    return this.source.getEqualityIndexFilter();
  }
  iterWithKeys(trackBandwidth = false) {
    return this.source.iterWithKeys(trackBandwidth);
  }
  narrow(bounds: IndexBounds): QueryStream<ActivityRow> {
    return new ActivityTimeStream(this.source.narrow(bounds));
  }
}
