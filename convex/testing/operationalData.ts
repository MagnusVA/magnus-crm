import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { cancelMeetingAttendanceCheck } from "../lib/attendanceChecks";

const DESTRUCTIVE_CONFIRMATION = "DELETE_OPERATIONAL_DATA";
const BATCH_SIZE = 64;

const OPERATIONAL_TABLES = [
  "meetingFormResponses",
  "meetingReassignments",
  "meetingReviews",
  "meetings",
  "followUps",
  "paymentRecords",
  "customers",
  "opportunities",
  "leadMergeHistory",
  "leadIdentifiers",
  "domainEvents",
  "closerUnavailability",
  "leads",
] as const;

const PRESERVED_TABLES = [
  "users",
  "calendlyOrgMembers",
  "eventTypeConfigs",
  "eventTypeFieldCatalog",
  "rawWebhookEvents",
  "tenantCalendlyConnections",
  "tenants",
  "tenantStats",
] as const;

type OperationalTableName = (typeof OPERATIONAL_TABLES)[number];
type PreservedTableName = (typeof PRESERVED_TABLES)[number];
type TableName = OperationalTableName | PreservedTableName;
type SnapshotResult = {
  confirmationToken: string;
  operationalTables: readonly OperationalTableName[];
  preservedTables: readonly PreservedTableName[];
  counts: Record<TableName, number>;
  totals: {
    operational: number;
    preserved: number;
  };
  notes: string[];
};
type ResetResult =
  | {
      mode: "dry_run";
      before: SnapshotResult;
    }
  | {
      mode: "executed";
      confirmation: string;
      deletedCounts: Record<OperationalTableName, number>;
      before: SnapshotResult;
      after: SnapshotResult;
      warnings: string[];
    };

async function countTableDocuments(
  ctx: QueryCtx,
  tableName: TableName,
): Promise<number> {
  let count = 0;
  for await (const _doc of ctx.db.query(tableName)) {
    count += 1;
  }
  return count;
}

async function deleteSimpleBatch(
  ctx: MutationCtx,
  tableName: Exclude<OperationalTableName, "meetings" | "paymentRecords">,
) {
  const rows = await ctx.db.query(tableName).take(BATCH_SIZE);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

async function deleteMeetingsBatch(ctx: MutationCtx) {
  const rows = await ctx.db.query("meetings").take(BATCH_SIZE);
  for (const row of rows) {
    await cancelMeetingAttendanceCheck(
      ctx,
      row.attendanceCheckId,
      "testing.resetOperationalData",
    );
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

async function deletePaymentRecordsBatch(ctx: MutationCtx) {
  const rows = await ctx.db.query("paymentRecords").take(BATCH_SIZE);
  for (const row of rows) {
    if (row.proofFileId) {
      await ctx.storage.delete(row.proofFileId);
    }
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

export const getSnapshot = internalQuery({
  args: {},
  handler: async (ctx): Promise<SnapshotResult> => {
    const counts: Record<TableName, number> = {
      users: await countTableDocuments(ctx, "users"),
      calendlyOrgMembers: await countTableDocuments(ctx, "calendlyOrgMembers"),
      eventTypeConfigs: await countTableDocuments(ctx, "eventTypeConfigs"),
      eventTypeFieldCatalog: await countTableDocuments(
        ctx,
        "eventTypeFieldCatalog",
      ),
      rawWebhookEvents: await countTableDocuments(ctx, "rawWebhookEvents"),
      tenantCalendlyConnections: await countTableDocuments(
        ctx,
        "tenantCalendlyConnections",
      ),
      tenants: await countTableDocuments(ctx, "tenants"),
      tenantStats: await countTableDocuments(ctx, "tenantStats"),
      meetingFormResponses: await countTableDocuments(
        ctx,
        "meetingFormResponses",
      ),
      meetingReassignments: await countTableDocuments(
        ctx,
        "meetingReassignments",
      ),
      meetingReviews: await countTableDocuments(ctx, "meetingReviews"),
      meetings: await countTableDocuments(ctx, "meetings"),
      followUps: await countTableDocuments(ctx, "followUps"),
      paymentRecords: await countTableDocuments(ctx, "paymentRecords"),
      customers: await countTableDocuments(ctx, "customers"),
      opportunities: await countTableDocuments(ctx, "opportunities"),
      leadMergeHistory: await countTableDocuments(ctx, "leadMergeHistory"),
      leadIdentifiers: await countTableDocuments(ctx, "leadIdentifiers"),
      domainEvents: await countTableDocuments(ctx, "domainEvents"),
      closerUnavailability: await countTableDocuments(
        ctx,
        "closerUnavailability",
      ),
      leads: await countTableDocuments(ctx, "leads"),
    };

    const operationalTotal = OPERATIONAL_TABLES.reduce(
      (sum, tableName) => sum + counts[tableName],
      0,
    );
    const preservedTotal = PRESERVED_TABLES.reduce(
      (sum, tableName) => sum + counts[tableName],
      0,
    );

    return {
      confirmationToken: DESTRUCTIVE_CONFIRMATION,
      operationalTables: OPERATIONAL_TABLES,
      preservedTables: PRESERVED_TABLES,
      counts,
      totals: {
        operational: operationalTotal,
        preserved: preservedTotal,
      },
      notes: [
        "tenantStats is preserved exactly as requested and may remain stale after a reset.",
        "rawWebhookEvents is preserved exactly as requested; webhook history remains in place.",
      ],
    };
  },
});

export const deleteOperationalDataBatch = internalMutation({
  args: {
    tableName: v.union(
      v.literal("meetingFormResponses"),
      v.literal("meetingReassignments"),
      v.literal("meetingReviews"),
      v.literal("meetings"),
      v.literal("followUps"),
      v.literal("paymentRecords"),
      v.literal("customers"),
      v.literal("opportunities"),
      v.literal("leadMergeHistory"),
      v.literal("leadIdentifiers"),
      v.literal("domainEvents"),
      v.literal("closerUnavailability"),
      v.literal("leads"),
    ),
  },
  handler: async (ctx, args) => {
    let deleted = 0;

    switch (args.tableName) {
      case "meetings":
        deleted = await deleteMeetingsBatch(ctx);
        break;
      case "paymentRecords":
        deleted = await deletePaymentRecordsBatch(ctx);
        break;
      default:
        deleted = await deleteSimpleBatch(ctx, args.tableName);
        break;
    }

    return {
      tableName: args.tableName,
      deleted,
      hasMore: deleted === BATCH_SIZE,
    };
  },
});

export const resetOperationalData = internalAction({
  args: {
    confirmation: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ResetResult> => {
    if (args.confirmation !== DESTRUCTIVE_CONFIRMATION) {
      throw new Error(
        `Confirmation token mismatch. Pass "${DESTRUCTIVE_CONFIRMATION}" to run this reset.`,
      );
    }

    const before: SnapshotResult = await ctx.runQuery(
      internal.testing.operationalData.getSnapshot,
      {},
    );

    if (args.dryRun !== false) {
      return {
        mode: "dry_run",
        before,
      };
    }

    const deletedCounts: Record<OperationalTableName, number> = {
      meetingFormResponses: 0,
      meetingReassignments: 0,
      meetingReviews: 0,
      meetings: 0,
      followUps: 0,
      paymentRecords: 0,
      customers: 0,
      opportunities: 0,
      leadMergeHistory: 0,
      leadIdentifiers: 0,
      domainEvents: 0,
      closerUnavailability: 0,
      leads: 0,
    };

    for (const tableName of OPERATIONAL_TABLES) {
      let hasMore = true;
      while (hasMore) {
        const result: {
          tableName: OperationalTableName;
          deleted: number;
          hasMore: boolean;
        } = await ctx.runMutation(
          internal.testing.operationalData.deleteOperationalDataBatch,
          { tableName },
        );
        deletedCounts[tableName] += result.deleted;
        hasMore = result.hasMore;
      }
    }

    const after: SnapshotResult = await ctx.runQuery(
      internal.testing.operationalData.getSnapshot,
      {},
    );

    return {
      mode: "executed",
      confirmation: DESTRUCTIVE_CONFIRMATION,
      deletedCounts,
      before,
      after,
      warnings: [
        "Preserved tenantStats documents were left untouched and may not match the reset operational tables.",
        "Preserved rawWebhookEvents documents remain available for audit/testing.",
      ],
    };
  },
});
