import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";

const CLEANUP_BATCH_SIZE = 128;

const TENANT_SCOPED_BY_TENANT_ID_TABLES = [
  "calendlyOrgMembers",
  "closerUnavailability",
  "customers",
  "eventTypeConfigs",
  "followUps",
  "leadIdentifiers",
  "leadMergeHistory",
  "leads",
  "meetingReassignments",
  "meetings",
  "opportunities",
  "paymentRecords",
  "rawWebhookEvents",
  "tenantCalendlyConnections",
  "tenantStats",
  "users",
] as const;

type TenantScopedByTenantIdTable =
  (typeof TENANT_SCOPED_BY_TENANT_ID_TABLES)[number];

async function deletePaymentRecordsBatch(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  const rows = await ctx.db
    .query("paymentRecords")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex("by_tenantId", (q: any) => q.eq("tenantId", tenantId))
    .take(CLEANUP_BATCH_SIZE);

  for (const row of rows) {
    if (row.proofFileId) {
      await ctx.storage.delete(row.proofFileId);
    }
    await ctx.db.delete(row._id);
  }

  return rows.length;
}

async function deleteByTenantIdBatch<TableName extends TenantScopedByTenantIdTable>(
  ctx: MutationCtx,
  tableName: TableName,
  tenantId: Id<"tenants">,
) {
  const rows = await ctx.db
    .query(tableName)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex("by_tenantId", (q: any) => q.eq("tenantId", tenantId))
    .take(CLEANUP_BATCH_SIZE);

  for (const row of rows) {
    await ctx.db.delete(row._id);
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
    await ctx.db.patch(tenantId, fields);
  },
});

export const deleteTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Admin] deleteTenant called", { tenantId });
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error("[Admin] deleteTenant: tenant not found", { tenantId });
      throw new Error("Tenant not found");
    }
    console.log("[Admin] deleteTenant: tenant found, deleting", {
      tenantId,
      companyName: tenant.companyName,
      status: tenant.status,
    });

    await ctx.db.delete(tenantId);
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

    for (const table of TENANT_SCOPED_BY_TENANT_ID_TABLES) {
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
      await ctx.db.delete(row._id);
    }
    deletedCounts.domainEvents = domainEvents.length;

    const meetingFormResponses = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of meetingFormResponses) {
      await ctx.db.delete(row._id);
    }
    deletedCounts.meetingFormResponses = meetingFormResponses.length;

    const eventTypeFieldCatalog = await ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of eventTypeFieldCatalog) {
      await ctx.db.delete(row._id);
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
