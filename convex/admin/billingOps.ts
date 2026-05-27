import { v } from "convex/values";
import type { UserIdentity } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { countBillingPayments } from "../billing/aggregates";
import { buildPaymentAuditSnapshot } from "../billing/audit";
import {
  BILLING_PAYMENT_STATUSES,
  type BillingCountArgs,
} from "../billing/types";
import { PAYMENT_TYPES } from "../lib/paymentTypes";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const VERIFY_TABLE_COUNT_LIMIT = 5000;
const VERIFY_TABLE_PAGE_SIZE = 250;
const VERIFY_PROGRAM_LIMIT = 50;
const LAST_90_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

type IndexedCountResult = {
  count: number;
  truncated: boolean;
};

function actorSubject(identity: UserIdentity) {
  return identity.tokenIdentifier ?? identity.subject;
}

function normalizeFilterForJson(filter: BillingCountArgs) {
  return {
    status: filter.status,
    programId: filter.programId ?? null,
    paymentType: filter.paymentType ?? null,
    startAt: filter.startAt ?? null,
    endAt: filter.endAt ?? null,
  };
}

function isAutomatedPassingSummary(summaryJson: string) {
  try {
    const parsed: unknown = JSON.parse(summaryJson);
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    return (
      "verificationSource" in parsed &&
      parsed.verificationSource === "automated" &&
      "verifiedSemanticsAccepted" in parsed &&
      parsed.verifiedSemanticsAccepted === true
    );
  } catch {
    return false;
  }
}

function boundedIndexedCount(rows: Array<Doc<"paymentRecords">>): IndexedCountResult {
  return {
    count: Math.min(rows.length, VERIFY_TABLE_COUNT_LIMIT),
    truncated: rows.length > VERIFY_TABLE_COUNT_LIMIT,
  };
}

async function countIndexedBillingPayments(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  filter: BillingCountArgs,
): Promise<IndexedCountResult> {
  if (filter.programId && filter.paymentType) {
    const programId = filter.programId;
    const paymentType = filter.paymentType;
    const rows = await ctx.db
      .query("paymentRecords")
      .withIndex(
        "by_tenantId_status_programId_paymentType_recordedAt",
        (q) => {
          const base = q
            .eq("tenantId", tenantId)
            .eq("status", filter.status)
            .eq("programId", programId)
            .eq("paymentType", paymentType);
          if (filter.startAt !== undefined && filter.endAt !== undefined) {
            return base
              .gte("recordedAt", filter.startAt)
              .lt("recordedAt", filter.endAt);
          }
          if (filter.startAt !== undefined) {
            return base.gte("recordedAt", filter.startAt);
          }
          if (filter.endAt !== undefined) {
            return base.lt("recordedAt", filter.endAt);
          }
          return base;
        },
      )
      .take(VERIFY_TABLE_COUNT_LIMIT + 1);
    return boundedIndexedCount(rows);
  }

  if (filter.programId) {
    const programId = filter.programId;
    const rows = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_programId_and_recordedAt", (q) => {
        const base = q
          .eq("tenantId", tenantId)
          .eq("status", filter.status)
          .eq("programId", programId);
        if (filter.startAt !== undefined && filter.endAt !== undefined) {
          return base
            .gte("recordedAt", filter.startAt)
            .lt("recordedAt", filter.endAt);
        }
        if (filter.startAt !== undefined) {
          return base.gte("recordedAt", filter.startAt);
        }
        if (filter.endAt !== undefined) {
          return base.lt("recordedAt", filter.endAt);
        }
        return base;
      })
      .take(VERIFY_TABLE_COUNT_LIMIT + 1);
    return boundedIndexedCount(rows);
  }

  if (filter.paymentType) {
    const paymentType = filter.paymentType;
    const rows = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_paymentType_and_recordedAt", (q) => {
        const base = q
          .eq("tenantId", tenantId)
          .eq("status", filter.status)
          .eq("paymentType", paymentType);
        if (filter.startAt !== undefined && filter.endAt !== undefined) {
          return base
            .gte("recordedAt", filter.startAt)
            .lt("recordedAt", filter.endAt);
        }
        if (filter.startAt !== undefined) {
          return base.gte("recordedAt", filter.startAt);
        }
        if (filter.endAt !== undefined) {
          return base.lt("recordedAt", filter.endAt);
        }
        return base;
      })
      .take(VERIFY_TABLE_COUNT_LIMIT + 1);
    return boundedIndexedCount(rows);
  }

  const rows = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_status_and_recordedAt", (q) => {
      const base = q.eq("tenantId", tenantId).eq("status", filter.status);
      if (filter.startAt !== undefined && filter.endAt !== undefined) {
        return base
          .gte("recordedAt", filter.startAt)
          .lt("recordedAt", filter.endAt);
      }
      if (filter.startAt !== undefined) {
        return base.gte("recordedAt", filter.startAt);
      }
      if (filter.endAt !== undefined) {
        return base.lt("recordedAt", filter.endAt);
      }
      return base;
    })
    .take(VERIFY_TABLE_COUNT_LIMIT + 1);
  return boundedIndexedCount(rows);
}

function buildVerificationFilters(
  programs: Array<Doc<"tenantPrograms">>,
  now: number,
): BillingCountArgs[] {
  const last90Start = now - LAST_90_DAYS_MS;
  const filters: BillingCountArgs[] = [];

  for (const status of BILLING_PAYMENT_STATUSES) {
    filters.push({ status });
    filters.push({ status, startAt: last90Start, endAt: now });

    for (const program of programs) {
      filters.push({ status, programId: program._id });
    }

    for (const paymentType of PAYMENT_TYPES) {
      filters.push({ status, paymentType, startAt: last90Start, endAt: now });
    }

    for (const program of programs) {
      for (const paymentType of PAYMENT_TYPES) {
        filters.push({
          status,
          programId: program._id,
          paymentType,
          startAt: last90Start,
          endAt: now,
        });
      }
    }
  }

  return filters;
}

export const getBillingOpsReadiness = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const [latest, latestPassed, tenant] = await Promise.all([
      ctx.db
        .query("billingOpsReadinessChecks")
        .withIndex("by_tenantId_and_checkedAt", (q) =>
          q.eq("tenantId", tenantId),
        )
        .order("desc")
        .first(),
      ctx.db
        .query("billingOpsReadinessChecks")
        .withIndex("by_tenantId_and_status_and_checkedAt", (q) =>
          q.eq("tenantId", tenantId).eq("status", "passed"),
        )
        .order("desc")
        .first(),
      ctx.db.get(tenantId),
    ]);

    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return {
      enabled: tenant.billingOpsEnabled === true,
      latest,
      latestPassed,
    };
  },
});

export const recordBillingOpsReadinessCheck = mutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(v.literal("passed"), v.literal("failed")),
    aggregateBackfilledAt: v.optional(v.number()),
    verifiedSemanticsAccepted: v.boolean(),
    filtersJson: v.string(),
    summaryJson: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    if (args.status === "passed") {
      if (!args.verifiedSemanticsAccepted) {
        throw new Error(
          "Billing Ops readiness cannot pass until verified status semantics are accepted.",
        );
      }
      if (args.aggregateBackfilledAt === undefined) {
        throw new Error(
          "Billing Ops readiness cannot pass without an aggregate backfill timestamp.",
        );
      }
    }

    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return await ctx.db.insert("billingOpsReadinessChecks", {
      tenantId: args.tenantId,
      actorSubject: actorSubject(identity),
      status: args.status,
      checkedAt: Date.now(),
      aggregateBackfilledAt: args.aggregateBackfilledAt,
      filtersJson: args.filtersJson,
      summaryJson: JSON.stringify({
        verificationSource: "manual",
        verifiedSemanticsAccepted: args.verifiedSemanticsAccepted,
        manualSummaryJson: args.summaryJson,
      }),
    });
  },
});

export const verifyBillingOpsReadiness = mutation({
  args: {
    tenantId: v.id("tenants"),
    aggregateBackfilledAt: v.optional(v.number()),
    verifiedSemanticsAccepted: v.boolean(),
    recentSampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const now = Date.now();
    const programRows = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .take(VERIFY_PROGRAM_LIMIT + 1);
    const programScanTruncated = programRows.length > VERIFY_PROGRAM_LIMIT;
    const programs = programRows.slice(0, VERIFY_PROGRAM_LIMIT);
    const filters = buildVerificationFilters(programs, now);
    const blockers: string[] = [];

    if (!args.verifiedSemanticsAccepted) {
      blockers.push("Product has not accepted verified === billing reviewed.");
    }
    if (args.aggregateBackfilledAt === undefined) {
      blockers.push("Billing aggregate backfill timestamp is missing.");
    } else if (args.aggregateBackfilledAt > now) {
      blockers.push("Billing aggregate backfill timestamp is in the future.");
    }
    if (programScanTruncated) {
      blockers.push(
        `Tenant has more than ${VERIFY_PROGRAM_LIMIT} programs; readiness filter matrix is truncated.`,
      );
    }

    const audit = await buildPaymentAuditSnapshot(
      ctx,
      args.tenantId,
      args.recentSampleLimit,
    );
    if (audit.metrics.missingRecordedByUser > 0) {
      blockers.push("Recent sample contains payments with unresolved registrants.");
    }
    if (audit.metrics.missingProgram > 0) {
      blockers.push("Recent sample contains payments with unresolved programs.");
    }

    const countResults = [];
    for (const filter of filters) {
      const [aggregateCount, indexedCount] = await Promise.all([
        countBillingPayments(ctx, args.tenantId, filter),
        countIndexedBillingPayments(ctx, args.tenantId, filter),
      ]);
      const matches =
        !indexedCount.truncated && aggregateCount === indexedCount.count;
      if (!matches) {
        blockers.push(
          `Billing aggregate mismatch for ${JSON.stringify(
            normalizeFilterForJson(filter),
          )}.`,
        );
      }
      countResults.push({
        filter: normalizeFilterForJson(filter),
        aggregateCount,
        indexedCount: indexedCount.count,
        indexedCountTruncated: indexedCount.truncated,
        matches,
      });
    }

    const status = blockers.length === 0 ? "passed" : "failed";
    const filtersJson = JSON.stringify({
      generatedAt: now,
      programIds: programs.map((program) => program._id),
      paymentTypes: PAYMENT_TYPES,
      filters: filters.map(normalizeFilterForJson),
      tableCountLimit: VERIFY_TABLE_COUNT_LIMIT,
      tablePageSize: VERIFY_TABLE_PAGE_SIZE,
      programLimit: VERIFY_PROGRAM_LIMIT,
    });
    const summaryJson = JSON.stringify({
      verificationSource: "automated",
      tenantId: args.tenantId,
      tenantName: tenant.companyName,
      verifiedSemanticsAccepted: args.verifiedSemanticsAccepted,
      aggregateBackfilledAt: args.aggregateBackfilledAt ?? null,
      status,
      blockers,
      audit,
      countResults,
    });

    const readinessCheckId = await ctx.db.insert("billingOpsReadinessChecks", {
      tenantId: args.tenantId,
      actorSubject: actorSubject(identity),
      status,
      checkedAt: now,
      aggregateBackfilledAt: args.aggregateBackfilledAt,
      filtersJson,
      summaryJson,
    });

    return {
      readinessCheckId,
      status,
      blockers,
      countResults,
      audit,
    };
  },
});

export const setBillingOpsEnabled = mutation({
  args: {
    tenantId: v.id("tenants"),
    enabled: v.boolean(),
  },
  handler: async (ctx, { tenantId, enabled }) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    if (enabled) {
      const latest = await ctx.db
        .query("billingOpsReadinessChecks")
        .withIndex("by_tenantId_and_checkedAt", (q) => q.eq("tenantId", tenantId))
        .order("desc")
        .first();

      if (!latest || latest.status !== "passed") {
        throw new Error(
          "Billing Ops cannot be enabled without a latest passing readiness check.",
        );
      }
      if (!isAutomatedPassingSummary(latest.summaryJson)) {
        throw new Error(
          "Billing Ops cannot be enabled without an automated passing readiness verification.",
        );
      }
      if (latest.aggregateBackfilledAt === undefined) {
        throw new Error("Billing aggregate backfill timestamp is missing.");
      }
      if (latest.checkedAt < latest.aggregateBackfilledAt) {
        throw new Error(
          "Billing Ops readiness must be checked after the aggregate backfill.",
        );
      }
    }

    await ctx.db.patch(tenantId, { billingOpsEnabled: enabled });
    console.log("[Admin:BillingOps] tenant gate updated", {
      tenantId,
      enabled,
      actor: actorSubject(identity),
    });

    return { tenantId, enabled };
  },
});
