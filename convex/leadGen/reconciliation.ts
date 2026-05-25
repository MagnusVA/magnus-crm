import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import {
  addBusinessDays,
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "../reporting/lib/hondurasBusinessTime";
import { requireTenantUser } from "../requireTenantUser";

const DEFAULT_AUDIT_ROW_LIMIT = 1000;
const MAX_AUDIT_ROW_LIMIT = 5000;
const AGGREGATE_ROW_LIMIT = 1000;
const MAX_RECONCILIATION_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_RECONCILIATION_REASON_LENGTH = 3;
const MAX_RECONCILIATION_REASON_LENGTH = 1000;

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
