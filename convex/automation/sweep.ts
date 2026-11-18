import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { scheduleEvaluation } from "./decisions";

const tenantPageArgs = { cursor: v.optional(v.string()), through: v.optional(v.number()) };
const paymentPageArgs = {
  tenantId: v.id("tenants"),
  connectionId: v.id("tenantPaymentConnections"),
  activationVersion: v.number(),
  connectedAt: v.number(),
  cursor: v.union(v.string(), v.null()),
  through: v.number(),
};
const tenantPage = makeFunctionReference<"mutation", ObjectType<typeof tenantPageArgs>>("automation/sweep:run");
const paymentPage = makeFunctionReference<"mutation", ObjectType<typeof paymentPageArgs>>("automation/sweep:connectionPage");

const pageSize = 20;
const maximumBytesRead = 256 * 1024;

async function scheduleTenantPayments(ctx: MutationCtx, tenant: Doc<"tenants">, through: number) {
  const settings = tenant.resultAutomation;
  if (tenant.status !== "active" || !settings?.enabled ||
      (settings.kinds.payment_win.mode === "off" && settings.kinds.additional_payment.mode === "off")) return;
  // One Whop connection per environment, with at most one active.
  for (const environment of ["live", "sandbox"] as const) {
    const connection = await ctx.db.query("tenantPaymentConnections")
      .withIndex("by_tenantId_and_provider_and_environment", (q) =>
        q.eq("tenantId", tenant._id).eq("provider", "whop").eq("environment", environment))
      .unique();
    if (!connection || connection.status === "disconnected") continue;
    await ctx.scheduler.runAfter(0, paymentPage, {
      tenantId: tenant._id, connectionId: connection._id, connectedAt: connection.connectedAt,
      activationVersion: settings.activationVersion, cursor: null, through,
    });
  }
}

export const tenantPayments = internalMutation({
  args: { tenantId: v.id("tenants"), activationVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { tenantId, activationVersion }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (tenant?.resultAutomation?.activationVersion === activationVersion) {
      await scheduleTenantPayments(ctx, tenant, Date.now() + 1);
    }
    return null;
  },
});

// Each mutation reads one indexed page. Scheduled continuations hold the
// cursor, cutoff and authority versions. Every cron tick starts a fresh pass
// so a failed or interrupted pass gets repaired on the next tick.
export const run = internalMutation({
  args: tenantPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const through = args.through ?? Date.now() + 1;
    const tenants = await ctx.db.query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active").lt("_creationTime", through))
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize, maximumBytesRead });
    for (const tenant of tenants.page) await scheduleTenantPayments(ctx, tenant, through);
    if (!tenants.isDone) await ctx.scheduler.runAfter(0, tenantPage, { through, cursor: tenants.continueCursor });
    return null;
  },
});

export const connectionPage = internalMutation({
  args: paymentPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const [tenant, connection] = await Promise.all([
      ctx.db.get("tenants", args.tenantId), ctx.db.get("tenantPaymentConnections", args.connectionId),
    ]);
    const settings = tenant?.resultAutomation;
    if (tenant?.status !== "active" || !settings?.enabled || settings.activationVersion !== args.activationVersion ||
        connection?.tenantId !== args.tenantId || connection.status === "disconnected" ||
        connection.connectedAt !== args.connectedAt) return null;

    // Use the stable identity index. Status and review state can change
    // under a payment as provider reads and Billing work are committed.
    const payments = await ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_connectionId_and_externalPaymentId", (q) =>
        q.eq("tenantId", args.tenantId).eq("connectionId", args.connectionId))
      .paginate({ cursor: args.cursor, numItems: pageSize, maximumBytesRead });
    for (const payment of payments.page) {
      if (payment._creationTime >= args.through) continue;
      if (payment.paymentRecordId || (payment.status === "paid" && payment.totalMinor !== 0 &&
          payment.reviewState !== "historical" && payment.reviewState !== "dismissed")) {
        await scheduleEvaluation(ctx, payment._id, "sweep");
      }
    }
    if (!payments.isDone) await ctx.scheduler.runAfter(0, paymentPage, { ...args, cursor: payments.continueCursor });
    return null;
  },
});
