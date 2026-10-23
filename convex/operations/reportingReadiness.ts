import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Existing tenants cannot show a partially rebuilt projection as a complete total. */
export async function requireReportingReady(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) throw new Error("Tenant not found");
  if (tenant.meetingProjectionVersion === 2) return;
  // Empty tenants need no rebuild. Read the source so readiness never depends
  // on whether a projection happens to be populated.
  const meeting = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId))
    .first();
  if (meeting) throw new Error("Reporting rebuild has not been verified");
}
