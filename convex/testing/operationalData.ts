import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

const DESTRUCTIVE_CONFIRMATION = "DELETE_OPERATIONAL_DATA";
const BATCH_SIZE = 64;

const OPERATIONAL_TABLES = [
  "billingExportEvents",
  "billingOpsReadinessChecks",
  "calendlyOrgMembers",
  "leadGenAuditMatches",
  "leadGenCorrectionEvents",
  "leadGenDailyStats",
  "leadGenOriginStats",
  "leadGenTeamOriginStats",
  "leadGenSubmissions",
  "leadGenProspects",
  "leadGenWorkerSchedules",
  "leadGenWorkers",
  "leadGenSettings",
  "linkPortalAuthAttempts",
  "linkPortalCopyEvents",
  "linkPortalCampaignPresets",
  "linkPortalConfigs",
  "meetingFormResponses",
  "meetingComments",
  "meetingReassignments",
  "operationsMeetingDailyStats",
  "meetings",
  "followUps",
  "paymentRecords",
  "customers",
  "operationsQualificationRows",
  "slackQualificationEvents",
  "opportunitySearch",
  "opportunities",
  "leadMergeHistory",
  "leadIdentifiers",
  "domainEvents",
  "closerUnavailability",
  "rawWebhookEvents",
  "rawSlackEvents",
  "slackOAuthStates",
  "slackUsers",
  "slackInstallations",
  "tenantStats",
  "tenantCalendlyConnections",
  "eventTypeFieldCatalog",
  "eventTypeConfigs",
  "tenantPrograms",
  "dmClosers",
  "attributionTeams",
  "leads",
  "users",
  "tenants",
  "supportTickets",
] as const;

const PRESERVED_TABLES = [] as const;

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
  for await (const row of ctx.db.query(tableName)) {
    if (row._id) {
      count += 1;
    }
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
      tenantCalendlyConnections: await countTableDocuments(
        ctx,
        "tenantCalendlyConnections",
      ),
      eventTypeConfigs: await countTableDocuments(ctx, "eventTypeConfigs"),
      eventTypeFieldCatalog: await countTableDocuments(
        ctx,
        "eventTypeFieldCatalog",
      ),
      tenantPrograms: await countTableDocuments(ctx, "tenantPrograms"),
      attributionTeams: await countTableDocuments(ctx, "attributionTeams"),
      dmClosers: await countTableDocuments(ctx, "dmClosers"),
      linkPortalConfigs: await countTableDocuments(ctx, "linkPortalConfigs"),
      linkPortalCampaignPresets: await countTableDocuments(
        ctx,
        "linkPortalCampaignPresets",
      ),
      leadGenSettings: await countTableDocuments(ctx, "leadGenSettings"),
      leadGenWorkers: await countTableDocuments(ctx, "leadGenWorkers"),
      leadGenWorkerSchedules: await countTableDocuments(
        ctx,
        "leadGenWorkerSchedules",
      ),
      slackInstallations: await countTableDocuments(ctx, "slackInstallations"),
      slackUsers: await countTableDocuments(ctx, "slackUsers"),
      tenants: await countTableDocuments(ctx, "tenants"),
      meetingFormResponses: await countTableDocuments(
        ctx,
        "meetingFormResponses",
      ),
      meetingComments: await countTableDocuments(ctx, "meetingComments"),
      meetingReassignments: await countTableDocuments(
        ctx,
        "meetingReassignments",
      ),
      operationsMeetingDailyStats: await countTableDocuments(
        ctx,
        "operationsMeetingDailyStats",
      ),
      meetings: await countTableDocuments(ctx, "meetings"),
      followUps: await countTableDocuments(ctx, "followUps"),
      paymentRecords: await countTableDocuments(ctx, "paymentRecords"),
      customers: await countTableDocuments(ctx, "customers"),
      operationsQualificationRows: await countTableDocuments(
        ctx,
        "operationsQualificationRows",
      ),
      slackQualificationEvents: await countTableDocuments(
        ctx,
        "slackQualificationEvents",
      ),
      opportunitySearch: await countTableDocuments(ctx, "opportunitySearch"),
      opportunities: await countTableDocuments(ctx, "opportunities"),
      leadGenAuditMatches: await countTableDocuments(
        ctx,
        "leadGenAuditMatches",
      ),
      leadGenCorrectionEvents: await countTableDocuments(
        ctx,
        "leadGenCorrectionEvents",
      ),
      leadGenDailyStats: await countTableDocuments(ctx, "leadGenDailyStats"),
      leadGenOriginStats: await countTableDocuments(ctx, "leadGenOriginStats"),
      leadGenTeamOriginStats: await countTableDocuments(
        ctx,
        "leadGenTeamOriginStats",
      ),
      leadGenSubmissions: await countTableDocuments(ctx, "leadGenSubmissions"),
      leadGenProspects: await countTableDocuments(ctx, "leadGenProspects"),
      leadMergeHistory: await countTableDocuments(ctx, "leadMergeHistory"),
      leadIdentifiers: await countTableDocuments(ctx, "leadIdentifiers"),
      domainEvents: await countTableDocuments(ctx, "domainEvents"),
      closerUnavailability: await countTableDocuments(
        ctx,
        "closerUnavailability",
      ),
      billingExportEvents: await countTableDocuments(ctx, "billingExportEvents"),
      billingOpsReadinessChecks: await countTableDocuments(
        ctx,
        "billingOpsReadinessChecks",
      ),
      linkPortalAuthAttempts: await countTableDocuments(
        ctx,
        "linkPortalAuthAttempts",
      ),
      linkPortalCopyEvents: await countTableDocuments(
        ctx,
        "linkPortalCopyEvents",
      ),
      rawWebhookEvents: await countTableDocuments(ctx, "rawWebhookEvents"),
      rawSlackEvents: await countTableDocuments(ctx, "rawSlackEvents"),
      slackOAuthStates: await countTableDocuments(ctx, "slackOAuthStates"),
      tenantStats: await countTableDocuments(ctx, "tenantStats"),
      leads: await countTableDocuments(ctx, "leads"),
      supportTickets: await countTableDocuments(ctx, "supportTickets"),
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
        "Full development reset: all app data tables are deleted when executed.",
        "WorkOS users and external provider state are not deleted by this Convex reset.",
      ],
    };
  },
});

export const deleteOperationalDataBatch = internalMutation({
  args: {
    tableName: v.union(
      v.literal("meetingFormResponses"),
      v.literal("meetingComments"),
      v.literal("meetingReassignments"),
      v.literal("operationsMeetingDailyStats"),
      v.literal("meetings"),
      v.literal("followUps"),
      v.literal("paymentRecords"),
      v.literal("customers"),
      v.literal("operationsQualificationRows"),
      v.literal("slackQualificationEvents"),
      v.literal("opportunitySearch"),
      v.literal("opportunities"),
      v.literal("leadMergeHistory"),
      v.literal("leadIdentifiers"),
      v.literal("domainEvents"),
      v.literal("closerUnavailability"),
      v.literal("billingExportEvents"),
      v.literal("billingOpsReadinessChecks"),
      v.literal("calendlyOrgMembers"),
      v.literal("leadGenAuditMatches"),
      v.literal("leadGenCorrectionEvents"),
      v.literal("leadGenDailyStats"),
      v.literal("leadGenOriginStats"),
      v.literal("leadGenTeamOriginStats"),
      v.literal("leadGenSubmissions"),
      v.literal("leadGenProspects"),
      v.literal("leadGenWorkerSchedules"),
      v.literal("leadGenWorkers"),
      v.literal("leadGenSettings"),
      v.literal("linkPortalAuthAttempts"),
      v.literal("linkPortalCopyEvents"),
      v.literal("linkPortalCampaignPresets"),
      v.literal("linkPortalConfigs"),
      v.literal("rawWebhookEvents"),
      v.literal("rawSlackEvents"),
      v.literal("slackOAuthStates"),
      v.literal("slackUsers"),
      v.literal("slackInstallations"),
      v.literal("tenantStats"),
      v.literal("tenantCalendlyConnections"),
      v.literal("eventTypeFieldCatalog"),
      v.literal("eventTypeConfigs"),
      v.literal("tenantPrograms"),
      v.literal("dmClosers"),
      v.literal("attributionTeams"),
      v.literal("leads"),
      v.literal("users"),
      v.literal("tenants"),
      v.literal("supportTickets"),
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
      meetingComments: 0,
      meetingReassignments: 0,
      operationsMeetingDailyStats: 0,
      meetings: 0,
      followUps: 0,
      paymentRecords: 0,
      customers: 0,
      operationsQualificationRows: 0,
      slackQualificationEvents: 0,
      opportunitySearch: 0,
      opportunities: 0,
      leadMergeHistory: 0,
      leadIdentifiers: 0,
      domainEvents: 0,
      closerUnavailability: 0,
      billingExportEvents: 0,
      billingOpsReadinessChecks: 0,
      calendlyOrgMembers: 0,
      leadGenAuditMatches: 0,
      leadGenCorrectionEvents: 0,
      leadGenDailyStats: 0,
      leadGenOriginStats: 0,
      leadGenTeamOriginStats: 0,
      leadGenSubmissions: 0,
      leadGenProspects: 0,
      leadGenWorkerSchedules: 0,
      leadGenWorkers: 0,
      leadGenSettings: 0,
      linkPortalAuthAttempts: 0,
      linkPortalCopyEvents: 0,
      linkPortalCampaignPresets: 0,
      linkPortalConfigs: 0,
      rawWebhookEvents: 0,
      rawSlackEvents: 0,
      slackOAuthStates: 0,
      slackUsers: 0,
      slackInstallations: 0,
      tenantStats: 0,
      tenantCalendlyConnections: 0,
      eventTypeFieldCatalog: 0,
      eventTypeConfigs: 0,
      tenantPrograms: 0,
      dmClosers: 0,
      attributionTeams: 0,
      leads: 0,
      users: 0,
      tenants: 0,
      supportTickets: 0,
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
        "All app data tables were targeted for deletion.",
        "WorkOS users and external provider state were not deleted by this Convex reset.",
      ],
    };
  },
});
