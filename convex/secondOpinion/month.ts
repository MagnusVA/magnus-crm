import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { readLiveQueryRows } from "../lib/liveQueryBounds";

/** Gateway invoices and the tenant cap use calendar months in UTC. */
export function monthRange(now: number) {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}
export function monthQuery(
  ctx: Pick<QueryCtx, "db">,
  tenantId: Id<"tenants">,
  now: number,
) {
  const { start, end } = monthRange(now);
  return ctx.db
    .query("secondOpinions")
    .withIndex("by_tenantId_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).gte("createdAt", start).lt("createdAt", end),
    );
}
/** Spend counts every check; the verdict counts skip checks a rerun replaced. */
export function summarize(all: Doc<"secondOpinions">[]) {
  const rows = all.filter((row) => row.supersededById === undefined);
  return {
    costUsd: all.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    total: rows.length,
    agrees: rows.filter((r) => r.verdict === "agrees").length,
    hints: rows.filter((r) => r.verdict === "hint").length,
    disagrees: rows.filter((r) => r.verdict === "disagrees").length,
    unsure: rows.filter((r) => r.verdict === "unsure").length,
    checked: rows.filter((r) => r.reviewState === "checked").length,
    answered: rows.filter((r) => r.status === "answered").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}
export async function monthSummary(
  ctx: Pick<QueryCtx, "db">,
  tenantId: Id<"tenants">,
  now: number,
) {
  const result = await readLiveQueryRows(
    monthQuery(ctx, tenantId, now).order("desc"),
    1000,
  );
  return { ...summarize(result.rows), capped: result.capped };
}
