import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { LIFECYCLE_STAGES } from "../leads/lifecycle";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import {
  leadGenWorkerMemberIdentity,
  memberAvatarIdentityValidator,
} from "../lib/memberIdentity";
import { countProspectConversions } from "../lib/prospectConversions";
import {
  addBusinessDays,
  businessDateToUtcStart,
} from "../reporting/lib/hondurasBusinessTime";
import { requireTenantUser } from "../requireTenantUser";

// Prospect-to-customer conversion by lead gen worker
// (docs/plans/phase-2-person-first.md §7). Credit goes to the worker who
// first captured the prospect, `firstCapturedByWorkerId`. A stage counts a
// prospect only when its person reached it at or after the first capture (D6).
//
// Deals counts the `lead_gen` attribution rows, which credit the worker whose
// capture was the person's first touch when the deal was created
// (docs/plans/phase-3-attribution.md §4.3, §6.6). A row's `attributedAt` is
// that capture's time, so Deals covers the same capture dates as the stages.
// The stage counts stay person-based: Prospect and In conversation have no
// deals, so no rows.

// Far above the tenant's lead gen workers (21 in production).
const WORKER_LIMIT = 500;

// One read of the range's lead gen rows. Only counts leave the query, so it
// takes more than the 512 KB live default: a row is about 410 bytes, and
// 2 MiB holds the row limit. The backfill expects 4,749 lead gen rows in
// production in all (docs/plans/phase-3-attribution.md §10.3).
export const CONVERSION_DEALS_READ_LIMIT = 5_000;
const CONVERSION_DEALS_BYTE_BUDGET = 2 * 1024 * 1024;

const stageCountsValidator = v.object({
  prospect: v.number(),
  in_conversation: v.number(),
  qualified: v.number(),
  booked: v.number(),
  showed: v.number(),
  customer: v.number(),
});

/** Lead gen deals per worker whose crediting capture is in `[startAt, endAt)`. */
async function countLeadGenDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startAt: number,
  endAt: number,
): Promise<{ byWorker: Map<Id<"leadGenWorkers">, number>; capped: boolean }> {
  const read = await readLiveQueryRows(
    ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("role", "lead_gen")
          .gte("attributedAt", startAt)
          .lt("attributedAt", endAt),
      ),
    CONVERSION_DEALS_READ_LIMIT,
    createLiveReadState(),
    CONVERSION_DEALS_BYTE_BUDGET,
  );
  const byWorker = new Map<Id<"leadGenWorkers">, number>();
  for (const row of read.rows) {
    if (row.source.kind !== "capture") continue;
    const workerId = row.source.workerId;
    byWorker.set(workerId, (byWorker.get(workerId) ?? 0) + 1);
  }
  return { byWorker, capped: read.capped };
}

export const listProspectConversions = query({
  args: { startDayKey: v.string(), endDayKey: v.string() },
  returns: v.object({
    rows: v.array(
      v.object({
        workerId: v.id("leadGenWorkers"),
        worker: memberAvatarIdentityValidator,
        displayName: v.string(),
        teamId: v.union(v.id("attributionTeams"), v.null()),
        counts: stageCountsValidator,
        // Deals whose person this worker found first.
        deals: v.number(),
      }),
    ),
    // More workers than one read covers; the table is partial.
    capped: v.boolean(),
    // More lead gen deals in the range than one read covers; Deals is partial.
    dealsCapped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    if (args.startDayKey > args.endDayKey) {
      throw new Error("Start date must be on or before end date");
    }
    const startAt = businessDateToUtcStart(args.startDayKey);
    const endAt = businessDateToUtcStart(addBusinessDays(args.endDayKey, 1));

    const workers = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", tenantId))
      .take(WORKER_LIMIT + 1);
    const capped = workers.length > WORKER_LIMIT;
    const deals = await countLeadGenDeals(ctx, tenantId, startAt, endAt);
    const rows = [];
    for (const worker of workers.slice(0, WORKER_LIMIT)) {
      const counts = {} as Record<(typeof LIFECYCLE_STAGES)[number], number>;
      for (const stage of LIFECYCLE_STAGES) {
        counts[stage] = await countProspectConversions(ctx, tenantId, worker._id, stage, startAt, endAt);
      }
      const workerDeals = deals.byWorker.get(worker._id) ?? 0;
      // A deal's capture is its prospect's first capture, so a worker with
      // deals in the range has prospects in it too. Should the two ever
      // disagree, the row stays, so no deal drops out of the table.
      if (counts.prospect === 0 && workerDeals === 0) {
        continue;
      }
      rows.push({
        workerId: worker._id,
        worker: await leadGenWorkerMemberIdentity(ctx, worker),
        displayName: worker.displayName ?? worker.email,
        teamId: worker.teamId ?? null,
        counts,
        deals: workerDeals,
      });
    }
    return {
      rows: rows.sort((left, right) => right.counts.prospect - left.counts.prospect),
      capped,
      dealsCapped: deals.capped,
    };
  },
});
