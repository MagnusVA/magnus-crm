import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { BUSINESS_DAY_REBUILD_MESSAGE } from "../../lib/businessDay";

export function runningBusinessDayRebuild(ctx: QueryCtx, tenantId: Id<"tenants">) {
  return ctx.db.query("businessDayRebuilds").withIndex("by_tenantId_and_state", q => q.eq("tenantId", tenantId).eq("state", "running")).unique();
}
export async function assertBusinessDayReady(ctx: QueryCtx, tenantId: Id<"tenants">) {
  if (await runningBusinessDayRebuild(ctx, tenantId)) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
  const failed = await ctx.db.query("businessDayRebuilds").withIndex("by_tenantId_and_state", q => q.eq("tenantId", tenantId).eq("state", "failed")).order("desc").first();
  if (failed) {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (failed.version === tenant?.businessDayVersion) throw new Error(BUSINESS_DAY_REBUILD_MESSAGE);
  }
}
/** Source writes continue; the compute pass restarts if its snapshot changed. */
export async function markLeadGenBusinessDayDirty(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const rebuild = await runningBusinessDayRebuild(ctx, tenantId);
  if (!rebuild) return false;
  await ctx.db.patch("businessDayRebuilds", rebuild._id, { sourceRevision: rebuild.sourceRevision + 1 });
  return true;
}
