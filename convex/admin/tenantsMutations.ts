import { v } from "convex/values";
import type { DataModel, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";

const CLEANUP_BATCH_SIZE = 128;

// Each tenant-scoped table, with an index whose first field is tenantId.
const TENANT_INDEX_BY_TABLE = {
  calendlyOrgMembers: "by_tenantId_and_calendlyUserUri",
  billingExportEvents: "by_tenantId_and_createdAt",
  billingOpsReadinessChecks: "by_tenantId_and_checkedAt",
  closerUnavailability: "by_tenantId_and_date",
  customers: "by_tenantId",
  eventTypeConfigs: "by_tenantId",
  followUps: "by_tenantId_and_closerId_and_status",
  leadIdentifiers: "by_tenantId_and_value",
  leadMergeHistory: "by_tenantId",
  leads: "by_tenantId",
  meetingReassignments: "by_tenantId_and_reassignedAt",
  meetings: "by_tenantId_and_scheduledAt",
  opportunities: "by_tenantId",
  paymentRecords: "by_tenantId_and_recordedAt",
  rawWebhookEvents: "by_tenantId_and_receivedAt",
  tenantCalendlyConnections: "by_tenantId",
  tenantStats: "by_tenantId",
  users: "by_tenantId",
} as const satisfies {
  [T in keyof DataModel]?: keyof DataModel[T]["indexes"];
};

type TenantScopedTable = keyof typeof TENANT_INDEX_BY_TABLE;

async function deletePaymentRecordsBatch(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  const rows = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", tenantId))
    .take(CLEANUP_BATCH_SIZE);

  for (const row of rows) {
    if (row.proofFileId) {
      await ctx.storage.delete(row.proofFileId);
    }
    await ctx.db.delete("paymentRecords", row._id);
  }

  return rows.length;
}

async function deleteByTenantIdBatch<TableName extends TenantScopedTable>(
  ctx: MutationCtx,
  tableName: TableName,
  tenantId: Id<"tenants">,
) {
  const rows = await ctx.db
    .query(tableName)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex(TENANT_INDEX_BY_TABLE[tableName], (q: any) =>
      q.eq("tenantId", tenantId),
    )
    .take(CLEANUP_BATCH_SIZE);

  for (const row of rows) {
    await ctx.db.delete(tableName, row._id);
  }

  return rows.length;
}

export const insertTenant = internalMutation({
  args: {
    companyName: v.string(),
    contactEmail: v.string(),
    workosOrgId: v.string(),
    notes: v.optional(v.string()),
    createdBy: v.string(),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    console.log("[Admin] insertTenant called", {
      companyName: args.companyName,
      contactEmail: args.contactEmail,
      workosOrgId: args.workosOrgId,
    });
    const id = await ctx.db.insert("tenants", {
      ...args,
      status: "pending_signup",
    });
    console.log("[Admin] insertTenant completed", { insertedId: id });
    return id;
  },
});

export const patchInviteToken = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, { tenantId, ...fields }) => {
    console.log("[Admin] patchInviteToken called", { tenantId });
    await ctx.db.patch("tenants", tenantId, fields);
  },
});

export const deleteTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Admin] deleteTenant called", { tenantId });
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      console.error("[Admin] deleteTenant: tenant not found", { tenantId });
      throw new Error("Tenant not found");
    }
    console.log("[Admin] deleteTenant: tenant found, deleting", {
      tenantId,
      companyName: tenant.companyName,
      status: tenant.status,
    });

    await ctx.db.delete("tenants", tenantId);
    console.log("[Admin] deleteTenant completed", { tenantId });
  },
});

export const deleteTenantRuntimeDataBatch = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Admin] deleteTenantRuntimeDataBatch called", { tenantId });

    const deletedCounts: Record<string, number> = {};

    deletedCounts.paymentRecords = await deletePaymentRecordsBatch(
      ctx,
      tenantId,
    );

    for (const table of Object.keys(
      TENANT_INDEX_BY_TABLE,
    ) as TenantScopedTable[]) {
      if (table === "paymentRecords") {
        continue;
      }

      deletedCounts[table] = await deleteByTenantIdBatch(ctx, table, tenantId);
    }

    const domainEvents = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of domainEvents) {
      await ctx.db.delete("domainEvents", row._id);
    }
    deletedCounts.domainEvents = domainEvents.length;

    const meetingFormResponses = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of meetingFormResponses) {
      await ctx.db.delete("meetingFormResponses", row._id);
    }
    deletedCounts.meetingFormResponses = meetingFormResponses.length;

    const eventTypeFieldCatalog = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of eventTypeFieldCatalog) {
      await ctx.db.delete("eventTypeFieldCatalog", row._id);
    }
    deletedCounts.eventTypeFieldCatalog = eventTypeFieldCatalog.length;

    const hasMore = Object.values(deletedCounts).some(
      (count) => count === CLEANUP_BATCH_SIZE,
    );

    console.log("[Admin] deleteTenantRuntimeDataBatch completed", {
      tenantId,
      deletedCounts,
      hasMore,
    });

    return {
      deletedCounts,
      hasMore,
    };
  },
});
