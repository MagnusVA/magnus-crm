import { v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const message =
  "Destructive webhook replay has been retired. Use pipeline/recovery:preview and pipeline/recovery:retry; rebuild reporting with migrations:rebuildMeetingProjections.";
// Keep explicit tombstones so old scripts fail before deleting any CRM data.
export const previewFreshStartFromRawWebhooks = action({
  args: { scheduledStartCutoffIso: v.string() },
  returns: v.null(),
  handler: async (ctx) => {
    requireSystemAdminSession(await ctx.auth.getUserIdentity());
    throw new Error(message);
  },
});
export const rebuildFreshStartFromRawWebhooks = action({
  args: {
    confirmDestructiveReset: v.boolean(),
    scheduledStartCutoffIso: v.string(),
  },
  returns: v.null(),
  handler: async (ctx) => {
    requireSystemAdminSession(await ctx.auth.getUserIdentity());
    throw new Error(message);
  },
});
export const deleteFreshStartOperationalDataBatch = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async () => {
    throw new Error(message);
  },
});
export const setRawWebhookProcessedState = internalMutation({
  args: { processed: v.boolean(), rawEventId: v.id("rawWebhookEvents") },
  returns: v.null(),
  handler: async () => {
    throw new Error(message);
  },
});
export const clearReportingAggregatesForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async () => {
    throw new Error(message);
  },
});
