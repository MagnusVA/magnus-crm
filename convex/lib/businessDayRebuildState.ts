import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { BUSINESS_DAY_REBUILD_MESSAGE } from "../../lib/businessDay";

export function runningBusinessDayRebuild(ctx: QueryCtx, tenantId: Id<"tenants">) {
  return ctx.db.query("businessDayRebuilds").withIndex("by_tenantId_and_state", q => q.eq("tenantId", tenantId).eq("state", "running")).unique();
}
export function businessDayBucketsReady(tenant: Doc<"tenants">) {
  return tenant.businessDayAppliedVersion !== undefined && tenant.businessDayAppliedVersion === (tenant.businessDayVersion ?? 0);
}
export async function assertBusinessDayReady(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant || !businessDayBucketsReady(tenant)) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
}
export async function leadGenBusinessDayBlocked(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const running = await runningBusinessDayRebuild(ctx, tenantId);
  if (running) return running.rebuildLeadGen !== false && !running.leadGenDone;
  const failed = await ctx.db.query("businessDayRebuilds").withIndex("by_tenantId_and_state", q => q.eq("tenantId", tenantId).eq("state", "failed")).order("desc").first();
  if (!failed || failed.rebuildLeadGen === false || failed.leadGenDone) return false;
  const tenant = await ctx.db.get("tenants", tenantId);
  return failed.version === tenant?.businessDayVersion;
}
export async function assertLeadGenBusinessDayReady(ctx: QueryCtx, tenantId: Id<"tenants">) {
  if (await leadGenBusinessDayBlocked(ctx, tenantId)) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
}
/** Append-only captures are caught up by watermark; corrections invalidate the snapshot. */
export async function markLeadGenBusinessDayDirty(ctx: MutationCtx, tenantId: Id<"tenants">, correction = false) {
  const rebuild = await runningBusinessDayRebuild(ctx, tenantId);
  if (!rebuild || rebuild.rebuildLeadGen === false || rebuild.leadGenDone) return false;
  await ctx.db.patch("businessDayRebuilds", rebuild._id, {
    sourceRevision: rebuild.sourceRevision + 1,
    ...(correction ? { correctionRevision: (rebuild.correctionRevision ?? 0) + 1 } : {}),
  });
  return true;
}
