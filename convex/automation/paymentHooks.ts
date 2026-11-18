import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { log } from "../lib/observability/log";

const paymentArgs = {
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  opportunityId: v.optional(v.id("opportunities")),
  paidAt: v.optional(v.number()),
  refusalOnly: v.optional(v.boolean()),
};
type PaymentArgs = ObjectType<typeof paymentArgs>;
const pageArgs = {
  ...paymentArgs,
  state: v.union(v.literal("ready"), v.literal("notice")),
  cursor: v.union(v.string(), v.null()),
  through: v.number(),
};
type PageArgs = ObjectType<typeof pageArgs>;
const stopPage = makeFunctionReference<"mutation", PageArgs>("automation/paymentHooks:stopPaymentPage");
const BATCH = 50;

function personDecisions(ctx: MutationCtx, args: Omit<PageArgs, "cursor" | "through">, through?: number) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_leadId_and_state", (q) => {
      const range = q.eq("tenantId", args.tenantId).eq("leadId", args.leadId).eq("state", args.state);
      return through === undefined ? range : range.lte("_creationTime", through);
    });
}

async function stopRows(ctx: MutationCtx, args: PaymentArgs, rows: Doc<"resultAutomationDecisions">[]) {
  const now = Date.now();
  for (const row of rows) {
    if (row.kind === "paid_on_call_alert" && row.state === "ready") {
      if (args.refusalOnly) continue;
      if (args.paidAt !== undefined && row.meetingId) {
        const meeting = await ctx.db.get("meetings", row.meetingId);
        if (meeting?.tenantId !== args.tenantId || args.paidAt < meeting.scheduledAt - 3_600_000) continue;
      }
    } else if (row.kind !== "refusal_loss") {
      continue;
    }
    await ctx.db.patch("resultAutomationDecisions", row._id, {
      state: "stopped", stopCode: "payment_found", resolvedAt: now,
    });
  }
}

/** A new payment for this person withdraws an outstanding refusal or alert. */
export async function stopCallDecisionsOnPayment(ctx: MutationCtx, args: PaymentArgs): Promise<void> {
  try {
    for (const state of ["ready", "notice"] as const) {
      const range = personDecisions(ctx, { ...args, state });
      const rows = await range.take(BATCH + 1);
      await stopRows(ctx, args, rows.slice(0, BATCH));
      if (rows.length > BATCH) {
        const through = (await range.order("desc").first())?._creationTime;
        if (through !== undefined) await ctx.scheduler.runAfter(0, stopPage, { ...args, state, through, cursor: null });
      }
    }
  } catch {
    log.warn("automation.call_payment_stop_failed", { tenantId: args.tenantId, leadId: args.leadId, opportunityId: args.opportunityId });
  }
}

export const stopPaymentPage = internalMutation({
  args: pageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await personDecisions(ctx, args, args.through).paginate({
      cursor: args.cursor, numItems: BATCH, maximumBytesRead: 256 * 1024,
    });
    await stopRows(ctx, args, page.page);
    if (!page.isDone) await ctx.scheduler.runAfter(0, stopPage, { ...args, cursor: page.continueCursor });
    return null;
  },
});
