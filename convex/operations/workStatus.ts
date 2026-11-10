import { buildWorkHealth } from "./workStatusCore";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { log, reportError } from "../lib/observability/log";
import {
  assertCoreRole,
  provenanceMetadata,
  WEB,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  requestMeetingProjection,
  requestOpportunityProjections,
} from "./meetingStats";

const status = v.union(
  v.literal("queued"),
  v.literal("applied"),
  v.literal("failed"),
);
const item = v.object({
  id: v.string(),
  sourceId: v.string(),
  generation: v.number(),
  status,
  requestedAt: v.number(),
  reason: v.optional(v.string()),
});
export const list = query({
  args: {
    kind: v.union(v.literal("meeting"), v.literal("opportunity")),
    status,
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(item),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_admin",
      "tenant_master",
    ]);
    const options = {
      ...args.paginationOpts,
      numItems: Math.min(100, args.paginationOpts.numItems),
    };
    if (args.kind === "meeting") {
      const result = await ctx.db
        .query("meetingProjections")
        .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
          q.eq("tenantId", tenantId).eq("status", args.status),
        )
        .paginate(options);
      return {
        isDone: result.isDone,
        continueCursor: result.continueCursor,
        page: result.page.map((r) => ({
          id: r._id,
          sourceId: r.meetingId,
          generation: r.generation,
          status: r.status,
          requestedAt: r.requestedAt,
          reason: r.reason,
        })),
      };
    }
    const result = await ctx.db
      .query("opportunityProjectionJobs")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", args.status),
      )
      .paginate(options);
    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      page: result.page.map((r) => ({
        id: r._id,
        sourceId: r.opportunityId,
        generation: r.generation,
        status: r.status,
        requestedAt: r.requestedAt,
        reason: r.reason,
      })),
    };
  },
});
export type RetryProjectionArgs = {
  kind: "meeting" | "opportunity";
  id: string;
  generation: number;
};

/**
 * Requeues one failed projection at the generation the caller saw: the core
 * of `retry`. No event covers a retry, so an agent's is recorded with its
 * provenance in a log line.
 */
export async function retryProjectionCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: RetryProjectionArgs,
  provenance: Provenance,
): Promise<null> {
  assertCoreRole(actor, ["tenant_admin", "tenant_master"]);
  const { tenantId } = actor;
  if (args.kind === "meeting") {
    const id = ctx.db.normalizeId("meetingProjections", args.id);
    const row = id ? await ctx.db.get("meetingProjections", id) : null;
    if (!row || row.tenantId !== tenantId)
      throw new Error("Projection not found");
    if (row.generation !== args.generation || row.status !== "failed")
      throw new Error("Projection retry is stale or work has not failed");
    await requestMeetingProjection(ctx, tenantId, row.meetingId);
  } else {
    const id = ctx.db.normalizeId("opportunityProjectionJobs", args.id);
    const row = id ? await ctx.db.get("opportunityProjectionJobs", id) : null;
    if (!row || row.tenantId !== tenantId)
      throw new Error("Projection not found");
    if (row.generation !== args.generation || row.status !== "failed")
      throw new Error("Projection retry is stale or work has not failed");
    await requestOpportunityProjections(ctx, row.opportunityId);
  }
  if (provenance.via === "mcp") {
    log.info("operations.projection.retried", {
      tenantId,
      actorUserId: actor.userId,
      kind: args.kind,
      projectionId: args.id,
      generation: args.generation,
      ...provenanceMetadata(provenance),
    });
  }
  return null;
}

export const retry = mutation({
  args: {
    kind: v.union(v.literal("meeting"), v.literal("opportunity")),
    id: v.string(),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_admin",
      "tenant_master",
    ]);
    return await retryProjectionCore(ctx, actor, args, WEB);
  },
});
const queueSummary = v.object({
  kind: v.string(),
  count: v.number(),
  capped: v.boolean(),
  oldestRequestedAt: v.optional(v.number()),
});
export const health = query({
  args: {},
  returns: v.object({ verified: v.boolean(), queues: v.array(queueSummary) }),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_admin",
      "tenant_master",
    ]);
    return await buildWorkHealth(ctx, tenantId);
  },
});

/** Bounded cron scan; the paginated admin queries provide the full backlog. */
export const reportProblems = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const status of ["queued", "failed"] as const) {
      const meetings = await ctx.db
        .query("meetingProjections")
        .withIndex("by_status_and_requestedAt", (q) =>
          q.eq("status", status).lt("requestedAt", cutoff),
        )
        .take(101);
      const fanout = await ctx.db
        .query("opportunityProjectionJobs")
        .withIndex("by_status_and_requestedAt", (q) =>
          q.eq("status", status).lt("requestedAt", cutoff),
        )
        .take(101);
      for (const [kind, rows] of [
        ["meeting", meetings],
        ["opportunity", fanout],
      ] as const) {
        if (rows.length)
          reportError(
            "reporting.work_requires_attention",
            new Error(`Reporting ${kind} work is ${status}`),
            {
              severity: "error",
              fingerprint: `reporting.work_requires_attention:${kind}:${status}`,
              count: Math.min(rows.length, 100),
              capped: rows.length > 100,
              oldestRequestedAt: rows[0].requestedAt,
            },
          );
      }
    }
    return null;
  },
});
