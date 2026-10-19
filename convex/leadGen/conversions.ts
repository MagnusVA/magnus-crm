import { v } from "convex/values";
import { query } from "../_generated/server";
import { LIFECYCLE_STAGES } from "../leads/lifecycle";
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
// first captured the prospect, `firstCapturedByWorkerId`; no attribution
// column is added (Phase 3 owns attribution). A stage counts a prospect only
// when its person reached it at or after the first capture (D6).

// Far above the tenant's lead gen workers (21 in production).
const WORKER_LIMIT = 500;

const stageCountsValidator = v.object({
  prospect: v.number(),
  in_conversation: v.number(),
  qualified: v.number(),
  booked: v.number(),
  showed: v.number(),
  customer: v.number(),
});

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
      }),
    ),
    // More workers than one read covers; the table is partial.
    capped: v.boolean(),
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
    const rows = [];
    for (const worker of workers.slice(0, WORKER_LIMIT)) {
      const counts = {} as Record<(typeof LIFECYCLE_STAGES)[number], number>;
      for (const stage of LIFECYCLE_STAGES) {
        counts[stage] = await countProspectConversions(ctx, tenantId, worker._id, stage, startAt, endAt);
      }
      if (counts.prospect === 0) {
        continue;
      }
      rows.push({
        workerId: worker._id,
        worker: await leadGenWorkerMemberIdentity(ctx, worker),
        displayName: worker.displayName ?? worker.email,
        teamId: worker.teamId ?? null,
        counts,
      });
    }
    return {
      rows: rows.sort((left, right) => right.counts.prospect - left.counts.prospect),
      capped,
    };
  },
});
