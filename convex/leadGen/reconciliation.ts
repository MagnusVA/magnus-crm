import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import { requireTenantUser } from "../requireTenantUser";
import {
  isRankableLeadGenOrigin,
  normalizeLeadGenOrigin,
} from "./normalization";

const DEFAULT_AUDIT_ROW_LIMIT = 1000;
const MAX_AUDIT_ROW_LIMIT = 5000;
const AGGREGATE_ROW_LIMIT = 1000;
const TEAM_ORIGIN_AUDIT_ROW_LIMIT = 1000;
const TEAM_ORIGIN_AUDIT_DIFF_LIMIT = 100;
const MAX_RECONCILIATION_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_RECONCILIATION_REASON_LENGTH = 3;
const MAX_RECONCILIATION_REASON_LENGTH = 1000;

type LeadGenSource = Doc<"leadGenSubmissions">["source"];
type TeamOriginGroup = {
  statKey: string;
  dayKey: string;
  teamId: Id<"attributionTeams"> | null;
  source: LeadGenSource;
  originKey: string;
  originValue: string;
  submissions: number;
  prospectIds: Set<Id<"leadGenProspects">>;
};

function validateTimestampRange(startTimestamp: number, endTimestamp: number) {
  if (
    !Number.isFinite(startTimestamp) ||
    !Number.isFinite(endTimestamp) ||
    endTimestamp <= startTimestamp
  ) {
    throw new Error("Invalid reconciliation timestamp range");
  }

  if (endTimestamp - startTimestamp > MAX_RECONCILIATION_RANGE_MS) {
    throw new Error("Reconciliation range cannot exceed 14 days");
  }
}

function normalizeReconciliationReason(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_RECONCILIATION_REASON_LENGTH) {
    throw new Error("A reconciliation reason is required");
  }
  if (trimmed.length > MAX_RECONCILIATION_REASON_LENGTH) {
    throw new Error(
      `Reconciliation reason must be ${MAX_RECONCILIATION_REASON_LENGTH} characters or fewer`,
    );
  }
  return trimmed;
}

function validateBusinessDayRange(args: {
  startDayKey: string;
  endDayKey: string;
}) {
  businessDateToUtcStart(args.startDayKey);
  businessDateToUtcStart(args.endDayKey);
  if (args.startDayKey > args.endDayKey) {
    throw new Error("Start date must be on or before end date");
  }
}

function teamOriginAuditKey(args: {
  dayKey: string;
  teamId?: Id<"attributionTeams">;
  source: LeadGenSource;
  originKey: string;
}) {
  return [
    args.dayKey,
    args.teamId ?? "none",
    args.source,
    args.originKey,
  ].join(":");
}

function getOrCreateTeamOriginGroup(
  groups: Map<string, TeamOriginGroup>,
  args: {
    statKey: string;
    dayKey: string;
    teamId?: Id<"attributionTeams">;
    source: LeadGenSource;
    originKey: string;
    originValue: string;
  },
) {
  const current =
    groups.get(args.statKey) ??
    {
      statKey: args.statKey,
      dayKey: args.dayKey,
      teamId: args.teamId ?? null,
      source: args.source,
      originKey: args.originKey,
      originValue: args.originValue,
      submissions: 0,
      prospectIds: new Set<Id<"leadGenProspects">>(),
    };
  groups.set(args.statKey, current);
  return current;
}

export const auditAggregateRange = query({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    maxRows: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (
      !Number.isFinite(args.startTimestamp) ||
      !Number.isFinite(args.endTimestamp) ||
      args.endTimestamp < args.startTimestamp
    ) {
      throw new Error("Invalid audit timestamp range");
    }

    const maxRows = args.maxRows ?? DEFAULT_AUDIT_ROW_LIMIT;
    if (
      !Number.isInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > MAX_AUDIT_ROW_LIMIT
    ) {
      throw new Error(
        `Audit row limit must be between 1 and ${MAX_AUDIT_ROW_LIMIT}`,
      );
    }

    const rawRows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("submittedAt", args.startTimestamp)
          .lte("submittedAt", args.endTimestamp),
      )
      .take(maxRows + 1);

    if (rawRows.length > maxRows) {
      throw new Error("Audit range is too large. Narrow the timestamp range.");
    }

    const activeRows = rawRows.filter((row) => row.voidedAt === undefined);
    const prospectIds = new Set(activeRows.map((row) => row.prospectId));
    const duplicateRows = activeRows.filter((row) => {
      const prospectAttempts = activeRows.filter(
        (candidate) => candidate.prospectId === row.prospectId,
      );
      return prospectAttempts.length > 1;
    });

    const startDayKey = timestampToBusinessDateKey(args.startTimestamp);
    const endDayKey = timestampToBusinessDateKey(args.endTimestamp);
    businessDateToUtcStart(startDayKey);
    businessDateToUtcStart(endDayKey);

    const aggregateRows = await ctx.db
      .query("leadGenDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", startDayKey)
          .lte("dayKey", endDayKey),
      )
      .take(AGGREGATE_ROW_LIMIT + 1);

    if (aggregateRows.length > AGGREGATE_ROW_LIMIT) {
      throw new Error("Aggregate audit range is too large.");
    }

    const aggregateSubmissions = aggregateRows.reduce(
      (sum, row) => sum + row.submissions,
      0,
    );
    const aggregateUniqueProspects = aggregateRows.reduce(
      (sum, row) => sum + row.uniqueProspectsSubmitted,
      0,
    );
    const aggregateDuplicates = aggregateRows.reduce(
      (sum, row) => sum + row.duplicateProspectSubmissions,
      0,
    );

    return {
      startDayKey,
      endDayKey,
      nextDayKey: addBusinessDays(endDayKey, 1),
      rawRowsChecked: rawRows.length,
      activeSubmissions: activeRows.length,
      activeUniqueProspects: prospectIds.size,
      activeDuplicateRows: duplicateRows.length,
      aggregateRowsChecked: aggregateRows.length,
      aggregateSubmissions,
      aggregateUniqueProspects,
      aggregateDuplicates,
      submissionDelta: aggregateSubmissions - activeRows.length,
      uniqueProspectDelta: aggregateUniqueProspects - prospectIds.size,
      duplicateDelta: aggregateDuplicates - duplicateRows.length,
      note: "Phase 5 owns repair mutations. This Phase 3 query is read-only drift detection.",
    };
  },
});

export const auditTeamOriginStatsRange = query({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateBusinessDayRange(args);

    const startTimestamp = businessDateToUtcStart(args.startDayKey);
    const endTimestamp =
      businessDateToUtcStart(addBusinessDays(args.endDayKey, 1)) - 1;
    const rawRows = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_submittedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("submittedAt", startTimestamp)
          .lte("submittedAt", endTimestamp),
      )
      .take(TEAM_ORIGIN_AUDIT_ROW_LIMIT + 1);

    if (rawRows.length > TEAM_ORIGIN_AUDIT_ROW_LIMIT) {
      throw new Error("Team-origin raw audit range is too large.");
    }

    const aggregateRows = await ctx.db
      .query("leadGenTeamOriginStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lte("dayKey", args.endDayKey),
      )
      .take(TEAM_ORIGIN_AUDIT_ROW_LIMIT + 1);

    if (aggregateRows.length > TEAM_ORIGIN_AUDIT_ROW_LIMIT) {
      throw new Error("Team-origin aggregate audit range is too large.");
    }

    const rawGroups = new Map<string, TeamOriginGroup>();
    for (const row of rawRows) {
      if (
        row.voidedAt !== undefined ||
        !row.originRankable ||
        !row.originValue ||
        !isRankableLeadGenOrigin(row.originKind)
      ) {
        continue;
      }

      const origin = normalizeLeadGenOrigin({
        originKind: row.originKind,
        originUrlOrLabel: row.originValue,
      });
      if (!origin.originKey || !origin.originValue) continue;

      const dayKey = timestampToBusinessDateKey(row.submittedAt);
      const statKey = teamOriginAuditKey({
        dayKey,
        teamId: row.teamId,
        source: row.source,
        originKey: origin.originKey,
      });
      const group = getOrCreateTeamOriginGroup(rawGroups, {
        statKey,
        dayKey,
        teamId: row.teamId,
        source: row.source,
        originKey: origin.originKey,
        originValue: origin.originValue,
      });

      group.submissions += 1;
      group.prospectIds.add(row.prospectId);
    }

    const aggregateGroups = new Map<
      string,
      Omit<TeamOriginGroup, "prospectIds"> & { uniqueProspects: number }
    >();
    for (const row of aggregateRows) {
      const current =
        aggregateGroups.get(row.statKey) ??
        {
          statKey: row.statKey,
          dayKey: row.dayKey,
          teamId: row.teamId ?? null,
          source: row.source,
          originKey: row.originKey,
          originValue: row.originValue,
          submissions: 0,
          uniqueProspects: 0,
        };

      current.submissions += row.submissions;
      current.uniqueProspects += row.uniqueProspectsSubmitted;
      aggregateGroups.set(row.statKey, current);
    }

    const allKeys = new Set([
      ...rawGroups.keys(),
      ...aggregateGroups.keys(),
    ]);
    const diffs = [...allKeys]
      .map((statKey) => {
        const raw = rawGroups.get(statKey);
        const aggregate = aggregateGroups.get(statKey);
        const template = raw ?? aggregate;
        if (!template) return null;

        const rawSubmissions = raw?.submissions ?? 0;
        const rawUniqueProspects = raw?.prospectIds.size ?? 0;
        const aggregateSubmissions = aggregate?.submissions ?? 0;
        const aggregateUniqueProspects = aggregate?.uniqueProspects ?? 0;

        if (
          rawSubmissions === aggregateSubmissions &&
          rawUniqueProspects === aggregateUniqueProspects
        ) {
          return null;
        }

        return {
          statKey,
          dayKey: template.dayKey,
          teamId: template.teamId,
          source: template.source,
          originKey: template.originKey,
          originValue: template.originValue,
          rawSubmissions,
          aggregateSubmissions,
          submissionDelta: aggregateSubmissions - rawSubmissions,
          rawUniqueProspects,
          aggregateUniqueProspects,
          uniqueProspectDelta:
            aggregateUniqueProspects - rawUniqueProspects,
        };
      })
      .filter((diff): diff is NonNullable<typeof diff> => diff !== null)
      .sort((a, b) => a.statKey.localeCompare(b.statKey));

    return {
      startDayKey: args.startDayKey,
      endDayKey: args.endDayKey,
      rawRowsChecked: rawRows.length,
      aggregateRowsChecked: aggregateRows.length,
      rawGroupCount: rawGroups.size,
      aggregateGroupCount: aggregateGroups.size,
      diffCount: diffs.length,
      diffs: diffs.slice(0, TEAM_ORIGIN_AUDIT_DIFF_LIMIT),
      truncatedDiffs: diffs.length > TEAM_ORIGIN_AUDIT_DIFF_LIMIT,
    };
  },
});

export const markRangeForReconciliation = mutation({
  args: {
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateTimestampRange(args.startTimestamp, args.endTimestamp);
    const reason = normalizeReconciliationReason(args.reason);
    const now = Date.now();
    const targetId = `range:${args.startTimestamp}:${args.endTimestamp}`;
    const beforeSnapshot = {
      startTimestamp: args.startTimestamp,
      endTimestamp: args.endTimestamp,
      reconciliationMarked: false,
    };
    const afterSnapshot = {
      startTimestamp: args.startTimestamp,
      endTimestamp: args.endTimestamp,
      reconciliationMarked: true,
      reason,
      correctedAt: now,
    };

    const correctionEventId = await ctx.db.insert("leadGenCorrectionEvents", {
      tenantId,
      targetType: "submission",
      targetId,
      correctionKind: "edited",
      reason,
      beforeSnapshot: JSON.stringify(beforeSnapshot),
      afterSnapshot: JSON.stringify(afterSnapshot),
      correctedByUserId: userId,
      correctedAt: now,
    });

    console.log("[LeadGen:Reconciliation] range marked for reconciliation", {
      correctionEventId,
      targetId,
      correctedByUserId: userId,
    });

    return {
      correctionEventId,
      targetId,
      marked: true,
    };
  },
});
