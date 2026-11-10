import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
export async function buildWorkHealth(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const tenant = await ctx.db.get("tenants", tenantId);
  const queues = [];
  for (const status of ["queued", "failed"] as const) {
    const meetings = await ctx.db
      .query("meetingProjections")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", status),
      )
      .take(101);
    const opportunities = await ctx.db
      .query("opportunityProjectionJobs")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", status),
      )
      .take(101);
    for (const [name, rows] of [
      ["meetings", meetings],
      ["opportunities", opportunities],
    ] as const)
      queues.push({
        kind: `${name}:${status}`,
        count: Math.min(rows.length, 100),
        capped: rows.length > 100,
        oldestRequestedAt: rows[0]?.requestedAt,
      });
  }
  for (const status of ["queued", "failed", "blocked"] as const) {
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", status),
      )
      .take(101);
    queues.push({
      kind: `webhooks:${status}`,
      count: Math.min(rows.length, 100),
      capped: rows.length > 100,
      oldestRequestedAt: rows[0]?.receivedAt,
    });
  }
  return { verified: tenant?.meetingProjectionVersion === 2, queues };
}
