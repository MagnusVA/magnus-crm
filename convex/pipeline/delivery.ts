import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import {
  internalMutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { deliveryStatus } from "./schema";
import { webhookPool } from "./workpools";

export async function enqueueDelivery(
  ctx: MutationCtx,
  deliveryId: Id<"webhookDeliveries">,
) {
  const receipt = await ctx.db.get("webhookDeliveries", deliveryId);
  if (!receipt) throw new Error("Delivery missing");
  const generation = receipt.generation + 1;
  const workId = await webhookPool.enqueueMutation(
    ctx,
    internal.pipeline.processor.processRawEvent,
    {
      rawEventId: receipt.rawEventId,
      generation,
    },
    {
      onComplete: internal.pipeline.delivery.completed,
      context: { deliveryId, generation },
    },
  );
  await ctx.db.patch("webhookDeliveries", deliveryId, {
    generation,
    workId,
    status: "queued",
    reason: undefined,
    processedAt: undefined,
  });
}

export const completed = internalMutation({
  args: vOnCompleteArgs(
    v.object({ deliveryId: v.id("webhookDeliveries"), generation: v.number() }),
  ),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    const receipt = await ctx.db.get("webhookDeliveries", context.deliveryId);
    if (
      !receipt ||
      receipt.generation !== context.generation ||
      receipt.status !== "queued"
    )
      return null;
    await ctx.db.patch("webhookDeliveries", receipt._id, {
      status: "failed",
      processedAt: Date.now(),
      // Errors can contain provider PII. Preserve a fixed operational reason here;
      // the function log retains the detailed exception under existing retention.
      reason:
        result.kind === "canceled" ? "work_canceled" : "processing_failed",
    });
    return null;
  },
});

const summary = v.object({
  _id: v.id("webhookDeliveries"),
  rawEventId: v.id("rawWebhookEvents"),
  eventType: v.string(),
  status: deliveryStatus,
  reason: v.optional(v.string()),
  occurredAt: v.number(),
  receivedAt: v.number(),
  processedAt: v.optional(v.number()),
  generation: v.number(),
  meetingId: v.optional(v.id("meetings")),
  opportunityId: v.optional(v.id("opportunities")),
  leadId: v.optional(v.id("leads")),
});
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(deliveryStatus),
  },
  returns: v.object({
    page: v.array(summary),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_admin",
      "tenant_master",
    ]);
    const q = args.status
      ? ctx.db
          .query("webhookDeliveries")
          .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
            q.eq("tenantId", tenantId).eq("status", args.status!),
          )
      : ctx.db
          .query("webhookDeliveries")
          .withIndex("by_tenantId_and_receivedAt", (q) =>
            q.eq("tenantId", tenantId),
          );
    const result = await q
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 100),
      });
    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      page: result.page.map((r) => ({
        _id: r._id,
        rawEventId: r.rawEventId,
        eventType: r.eventType,
        status: r.status,
        reason: r.reason,
        occurredAt: r.occurredAt,
        receivedAt: r.receivedAt,
        processedAt: r.processedAt,
        generation: r.generation,
        meetingId: r.meetingId,
        opportunityId: r.opportunityId,
        leadId: r.leadId,
      })),
    };
  },
});
