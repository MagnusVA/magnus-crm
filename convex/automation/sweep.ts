import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { MAX_PROVIDER_PAYMENT_AGE_MS } from "../payments/reviewTiming";
import { transcriptGone } from "../callInsights/retention";
import { headerFor } from "../callInsights/trigger";
import { tripOverdueAudit } from "./audit";
import { checkTenantBreakers } from "./breaker";
import { scheduleCallEvaluation } from "./callDecisions";
import { schedulePaymentEvaluation, stopDecision } from "./decisions";
import { scheduleRefusalDeadlinePass } from "./notice";
import { isCallKind } from "./proposals";
import { effectiveKindMode } from "./settings";

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
const repairIntervalMs = 15 * 60_000; // payment-decision-repair in crons.ts
const paymentRepairBandMs = MAX_PROVIDER_PAYMENT_AGE_MS + 86_400_000;
const paymentKinds = ["payment_win", "additional_payment"] as const;
const outstandingStates = ["ready", "shadow", "needs_person", "blocked"] as const;
const decisionLanes = paymentKinds.flatMap((kind) => outstandingStates.map((state) => ({ kind, state })));
const decisionPageArgs = {
  tenantId: v.id("tenants"),
  connectionId: v.id("tenantPaymentConnections"),
  connectedAt: v.number(),
  activationVersion: v.number(),
  through: v.number(),
};
const decisionPage = makeFunctionReference<"mutation", ObjectType<typeof decisionPageArgs>>("automation/sweep:paymentDecisionPage");
const evaluatePayment = makeFunctionReference<"mutation", {
  providerPaymentId: Id<"providerPayments">; activationVersion: number; cause: "sweep";
}>("automation/decisions:evaluateProviderPayment");
const maximumBytesRead = 256 * 1024;

function paymentPolicy(tenant: Doc<"tenants"> | null) {
  const settings = tenant?.resultAutomation;
  return tenant?.status === "active" && settings?.enabled &&
    paymentKinds.some((kind) => settings.kinds[kind].mode !== "off") ? settings : null;
}

async function scheduleTenantPayments(ctx: MutationCtx, tenant: Doc<"tenants">, through: number) {
  const settings = paymentPolicy(tenant);
  if (!settings) return;
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

// Payment repair advances one page per connection per tick. The other work
// is separate, so a payment backlog cannot delay deadlines.
export const run = internalMutation({
  args: tenantPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const through = args.through ?? now + 1;
    if (args.through === undefined) {
      await ctx.scheduler.runAfter(0, auditPage, { cursor: null, through: now });
      await ctx.scheduler.runAfter(0, duePage, { cursor: null, through: now });
      await scheduleRefusalDeadlinePass(ctx, now);
    }
    const tenants = await ctx.db.query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active").lt("_creationTime", through))
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize, maximumBytesRead });
    for (const tenant of tenants.page) {
      await checkTenantBreakers(ctx, tenant, now);
      await scheduleTenantPayments(ctx, tenant, through);
      if ((["call_back", "payment_owed", "refusal_loss"] as const).some((kind) =>
        effectiveKindMode(tenant, kind) !== "off")) {
        await ctx.scheduler.runAfter(0, callRepairRef, {
          tenantId: tenant._id, state: "ready", cursor: null, through,
        });
      }
    }
    if (!tenants.isDone) await ctx.scheduler.runAfter(0, tenantPage, { through, cursor: tenants.continueCursor });
    return null;
  },
});

export const connectionPage = internalMutation({
  args: paymentPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const repair = await loadPaymentRepair(ctx, args);
    if (!repair) return null;
    const { connection, cursor, policyVersions } = repair;
    const samePolicy = cursor?.policyVersions === policyVersions &&
      cursor.connectedAt === args.connectedAt && cursor.activationVersion === args.activationVersion;
    // Half the interval: a cron that starts a little early must not skip its tick.
    if (samePolicy && args.through - cursor.lastTick < repairIntervalMs / 2) return null;

    const through = (samePolicy ? cursor.paymentThrough : undefined) ?? args.through;
    const payments = await ctx.db.query("providerPayments")
      .withIndex("by_connectionId_status_paymentRecordId_paidAt", (q) => q
        .eq("connectionId", args.connectionId).eq("status", "paid").eq("paymentRecordId", undefined)
        .gte("paidAt", Math.max(connection.autoImportAfter + 1, through - paymentRepairBandMs))
        .lt("paidAt", through))
      .paginate({
        cursor: samePolicy ? cursor.paymentCursor ?? null : null,
        numItems: pageSize, maximumBytesRead,
      });
    for (const payment of payments.page) {
      if (payment.totalMinor !== 0 && payment.reviewState !== "historical" && payment.reviewState !== "dismissed") {
        await schedulePaymentEvaluation(ctx, args.tenantId, payment, "sweep");
      }
    }
    const checkpoint = {
      tenantId: args.tenantId, connectionId: args.connectionId,
      connectedAt: args.connectedAt, activationVersion: args.activationVersion,
      policyVersions, lastTick: args.through,
      paymentCursor: payments.isDone ? undefined : payments.continueCursor,
      paymentThrough: payments.isDone ? undefined : through,
      decisionLane: samePolicy ? cursor.decisionLane : 0,
      decisionCursor: samePolicy ? cursor.decisionCursor : undefined,
      decisionThrough: samePolicy ? cursor.decisionThrough : undefined,
    };
    if (cursor) await ctx.db.patch("automationPaymentRepairCursors", cursor._id, checkpoint);
    else await ctx.db.insert("automationPaymentRepairCursors", checkpoint);
    const { tenantId, connectionId, connectedAt, activationVersion } = args;
    await ctx.scheduler.runAfter(0, decisionPage, { tenantId, connectionId, connectedAt, activationVersion, through: args.through });
    return null;
  },
});

async function loadPaymentRepair(ctx: MutationCtx, args: ObjectType<typeof decisionPageArgs>) {
  const [tenant, connection] = await Promise.all([
    ctx.db.get("tenants", args.tenantId), ctx.db.get("tenantPaymentConnections", args.connectionId),
  ]);
  const settings = paymentPolicy(tenant);
  if (settings?.activationVersion !== args.activationVersion ||
      connection?.tenantId !== args.tenantId || connection.status === "disconnected" ||
      connection.connectedAt !== args.connectedAt) return null;
  const cursor = await ctx.db.query("automationPaymentRepairCursors")
    .withIndex("by_connectionId", (q) => q.eq("connectionId", args.connectionId))
    .unique();
  const policyVersions = paymentKinds.map((kind) => settings.kinds[kind].policyVersion).join(":");
  return { connection, cursor, policyVersions };
}

// Check outstanding decisions even after their payments leave the paid-date band.
// Each tick advances one decision page, independently of the payment cursor.
export const paymentDecisionPage = internalMutation({
  args: decisionPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const repair = await loadPaymentRepair(ctx, args);
    const cursor = repair?.cursor;
    if (!cursor || cursor.lastTick !== args.through || cursor.policyVersions !== repair?.policyVersions) return null;

    const { kind, state } = decisionLanes[cursor.decisionLane];
    const through = cursor.decisionThrough ?? args.through;
    const decisions = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_kind_and_state_and_createdAt", (q) => q
        .eq("tenantId", args.tenantId).eq("kind", kind).eq("state", state).lt("createdAt", through))
      .paginate({ cursor: cursor.decisionCursor ?? null, numItems: pageSize, maximumBytesRead });
    const paidAfter = Date.now() - paymentRepairBandMs;
    for (const decision of decisions.page) {
      if (!decision.providerPaymentId) continue;
      const payment = await ctx.db.get("providerPayments", decision.providerPaymentId);
      if (payment?.tenantId !== args.tenantId || payment.connectionId !== args.connectionId) continue;
      // The recent page covers normal paid rows. Old rows already gated as
      // stale have no live proposal unless some other input changed.
      if (!payment.paymentRecordId && payment.status === "paid" && payment.totalMinor !== 0 &&
          payment.reviewState !== "historical" && payment.reviewState !== "dismissed" &&
          (decision.gates.includes("stale_payment") || (payment.paidAt ?? 0) >= paidAfter)) continue;
      await ctx.scheduler.runAfter(0, evaluatePayment, {
        providerPaymentId: payment._id, activationVersion: args.activationVersion, cause: "sweep",
      });
    }
    await ctx.db.patch("automationPaymentRepairCursors", cursor._id, {
      decisionLane: decisions.isDone ? (cursor.decisionLane + 1) % decisionLanes.length : cursor.decisionLane,
      decisionCursor: decisions.isDone ? undefined : decisions.continueCursor,
      decisionThrough: decisions.isDone ? undefined : through,
    });
    return null;
  },
});

const callRepairArgs = {
  tenantId: v.id("tenants"),
  state: v.union(v.literal("ready"), v.literal("notice")),
  cursor: v.union(v.string(), v.null()),
  through: v.number(),
};
const callRepairRef = makeFunctionReference<"mutation", ObjectType<typeof callRepairArgs>>("automation/sweep:callRepair");

export const callRepair = internalMutation({
  args: callRepairArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_state_and_createdAt", (q) =>
        q.eq("tenantId", args.tenantId).eq("state", args.state).lt("createdAt", args.through))
      .paginate({ cursor: args.cursor, numItems: 50, maximumBytesRead });
    const now = Date.now();
    for (const row of page.page) {
      if (!isCallKind(row.kind) || !row.recordingId) continue;
      const recording = await ctx.db.get("callRecordings", row.recordingId);
      if (recording?.tenantId !== args.tenantId || recording.matchStatus !== "matched" ||
          recording.meetingId !== row.meetingId) {
        await stopDecision(ctx, row._id, null, "recording_moved");
        continue;
      }
      const header = await headerFor(ctx, recording._id);
      if (transcriptGone(recording, now) || header?.quotesPurgedAt !== undefined) {
        await stopDecision(ctx, row._id, null, "transcript_gone");
      } else if (!header?.active || header.meetingId !== row.meetingId || header.publishedRunId !== row.runId) {
        await stopDecision(ctx, row._id, null, "input_changed");
      } else if (row.mode === "automatic") {
        const tenant = await ctx.db.get("tenants", row.tenantId);
        const policy = tenant?.resultAutomation?.kinds[row.kind];
        if (tenant && row.meetingId && policy?.breaker && row.policyVersion < policy.policyVersion) {
          await stopDecision(ctx, row._id, null, policy.breaker.reason === "certificate_lapsed" ? "certificate_lapsed" : "breaker");
          await scheduleCallEvaluation(ctx, tenant, row.meetingId, "sweep");
        }
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, callRepairRef, { ...args, cursor: page.continueCursor });
    else if (args.state === "ready") await ctx.scheduler.runAfter(0, callRepairRef, { ...args, state: "notice", cursor: null });
    return null;
  },
});

const auditPageArgs = { cursor: v.union(v.string(), v.null()), through: v.number() };
type AuditPageArgs = ObjectType<typeof auditPageArgs>;
const auditPage = makeFunctionReference<"mutation", AuditPageArgs>("automation/sweep:auditDeadlinePage");

async function sweepOverdueAudits(ctx: MutationCtx, args: AuditPageArgs) {
  const page = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_auditOpenDueAt", (q) => q.gt("auditOpenDueAt", undefined).lte("auditOpenDueAt", args.through))
    .paginate({ cursor: args.cursor, numItems: pageSize, maximumBytesRead });
  for (const row of page.page) await tripOverdueAudit(ctx, row, args.through);
  if (!page.isDone) await ctx.scheduler.runAfter(0, auditPage, { ...args, cursor: page.continueCursor });
}

export const auditDeadlinePage = internalMutation({
  args: auditPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await sweepOverdueAudits(ctx, args);
    return null;
  },
});

// Due automatic writes (D2): a missed wake-up is retried here. Each row is
// handed to its executor in its own mutation, which re-checks everything.
const duePageArgs = { cursor: v.union(v.string(), v.null()), through: v.number() };
type DuePageArgs = ObjectType<typeof duePageArgs>;
const duePage = makeFunctionReference<"mutation", DuePageArgs>("automation/sweep:dueAutomaticPage");
const executeAutomaticPaymentRef = makeFunctionReference<"mutation", { decisionId: Id<"resultAutomationDecisions"> }>(
  "automation/automaticPayments:executeAutomaticPayment",
);
const executeCallTaskRef = makeFunctionReference<"mutation", { decisionId: Id<"resultAutomationDecisions"> }>(
  "automation/apply:executeCallTask",
);
const DUE_PAGE_SIZE = 50;

export const dueAutomaticPage = internalMutation({
  args: duePageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_state_and_dueAt", (q) => q.eq("state", "ready").gt("dueAt", undefined).lte("dueAt", args.through))
      .paginate({ cursor: args.cursor, numItems: DUE_PAGE_SIZE, maximumBytesRead });
    for (const row of page.page) {
      if (row.mode !== "automatic") continue;
      if (row.kind === "payment_win" || row.kind === "additional_payment") {
        await ctx.scheduler.runAfter(0, executeAutomaticPaymentRef, { decisionId: row._id });
      } else if (row.kind === "call_back" || row.kind === "payment_owed") {
        await ctx.scheduler.runAfter(0, executeCallTaskRef, { decisionId: row._id });
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, duePage, { ...args, cursor: page.continueCursor });
    return null;
  },
});
