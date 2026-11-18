import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import { PAYMENT_RULE_VERSION } from "./derive";
import { effectiveKindMode } from "./settings";

const countValidator = v.object({ count: v.number(), capped: v.boolean() });
const nullableNumber = v.union(v.number(), v.null());
const queueValidator = v.object({ ...countValidator.fields, oldestAt: nullableNumber });
const kindStats = v.object({
  ruleVersion: v.string(),
  proposed: countValidator,
  leftForPerson: countValidator,
  graded: countValidator,
  wrong: countValidator,
  ungraded: queueValidator,
  shareOfPaidWhopPayments: nullableNumber,
  corrected: countValidator,
});

const kinds = ["payment_win", "additional_payment"] as const;
const limit = 500;
type Payment = Doc<"providerPayments">;
type Tenant = Doc<"tenants">;

function count(n: number, capped: boolean) {
  return { count: n, capped };
}

function oldest(current: number | null, time: number) {
  return current === null ? time : Math.min(current, time);
}

async function readKind(
  ctx: QueryCtx, tenantId: Id<"tenants">, kind: (typeof kinds)[number], since: number,
  paidInWindow: Set<Id<"providerPayments">>, paymentsCapped: boolean,
) {
  const rows = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", kind).eq("ruleVersion", PAYMENT_RULE_VERSION).gte("createdAt", since))
    .take(limit + 1);
  const capped = rows.length > limit;
  let proposed = 0;
  let leftForPerson = 0;
  let graded = 0;
  let wrong = 0;
  let corrected = 0;
  let oldestUngraded: number | null = null;
  const covered = new Set<Id<"providerPayments">>();
  for (const row of rows.slice(0, limit)) {
    if (row.wouldWrite) {
      proposed += 1;
      if (row.providerPaymentId && paidInWindow.has(row.providerPaymentId)) covered.add(row.providerPaymentId);
    } else {
      leftForPerson += 1;
    }
    if (row.grade) {
      graded += 1;
      if ((row.grade.secondLook?.verdict ?? row.grade.verdict) === "wrong") wrong += 1;
    } else {
      oldestUngraded = oldest(oldestUngraded, row.createdAt);
    }
    if (row.correctionId || row.state === "corrected" || row.state === "undone") corrected += 1;
  }
  return {
    ruleVersion: PAYMENT_RULE_VERSION,
    proposed: count(proposed, capped),
    leftForPerson: count(leftForPerson, capped),
    graded: count(graded, capped),
    wrong: count(wrong, capped),
    ungraded: { ...count(Math.min(rows.length, limit) - graded, capped), oldestAt: oldestUngraded },
    shareOfPaidWhopPayments: capped || paymentsCapped || paidInWindow.size === 0
      ? null : covered.size / paidInWindow.size,
    corrected: count(corrected, capped),
  };
}

async function waitingPayments(ctx: QueryCtx, tenant: Tenant, connections: Doc<"tenantPaymentConnections">[]) {
  const ranges = await Promise.all(connections.map((connection) => ctx.db.query("providerPayments")
    .withIndex("by_connectionId_and_tenantId_and_reviewState_and_firstSeenAt", (q) =>
      q.eq("connectionId", connection._id).eq("tenantId", tenant._id).eq("reviewState", "needs_person"))
    .take(limit + 1)));
  const ready = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_state_and_createdAt", (q) => q.eq("tenantId", tenant._id).eq("state", "ready"))
    .take(limit + 1);
  const closer = new Set<Id<"providerPayments">>();
  for (const row of ready.slice(0, limit)) {
    if (row.providerPaymentId && row.noticeUserId && row.activationVersion === tenant.resultAutomation?.activationVersion &&
        row.policyVersion === tenant.resultAutomation?.kinds[row.kind]?.policyVersion &&
        effectiveKindMode(tenant, row.kind) === "ask") closer.add(row.providerPaymentId);
  }

  let billingCount = 0;
  let closerCount = 0;
  let oldestAt: number | null = null;
  let closerOldest: number | null = null;
  let billingOldest: number | null = null;
  for (const rows of ranges) {
    for (const row of rows.slice(0, limit)) {
      if (row.paymentRecordId || row.status !== "paid" || row.totalMinor === 0) continue;
      oldestAt = oldest(oldestAt, row.firstSeenAt);
      if (closer.has(row._id)) {
        closerCount += 1;
        closerOldest = oldest(closerOldest, row.firstSeenAt);
      } else {
        billingCount += 1;
        billingOldest = oldest(billingOldest, row.firstSeenAt);
      }
    }
  }
  const capped = ranges.some((rows) => rows.length > limit);
  const routingCapped = capped || ready.length > limit;
  return {
    ...count(billingCount + closerCount, capped), oldestAt,
    billing: {
      ...count(ready.length > limit ? 0 : billingCount, routingCapped),
      oldestAt: ready.length > limit ? null : billingOldest,
    },
    closer: { ...count(closerCount, routingCapped), oldestAt: closerOldest },
  };
}

async function attendanceOwed(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const rows = await ctx.db.query("meetings")
    .withIndex("by_tenantId_and_status_and_attendanceOwedSince", (q) =>
      q.eq("tenantId", tenantId).eq("status", "scheduled").gt("attendanceOwedSince", undefined))
    .take(limit + 1);
  const deals = new Set<Id<"opportunities">>();
  let oldestAt: number | null = null;
  for (const meeting of rows.slice(0, limit)) {
    if (deals.has(meeting.opportunityId) || meeting.attendanceOwedSince === undefined) continue;
    const deal = await ctx.db.get("opportunities", meeting.opportunityId);
    if (deal?.tenantId !== tenantId || deal.outcome !== "won") continue;
    deals.add(meeting.opportunityId);
    oldestAt = oldest(oldestAt, meeting.attendanceOwedSince);
  }
  return { ...count(deals.size, rows.length > limit), oldestAt };
}

async function paidWindow(ctx: QueryCtx, tenantId: Id<"tenants">, connections: Doc<"tenantPaymentConnections">[], since: number) {
  const ranges = await Promise.all(connections.map((connection) => ctx.db.query("providerPayments")
    .withIndex("by_connectionId_and_status_and_sourceCreatedAt_and_firstSeenAt", (q) =>
      q.eq("connectionId", connection._id).eq("status", "paid")).order("desc").take(limit + 1)));
  const ids = new Set<Id<"providerPayments">>();
  for (const rows of ranges) {
    for (const row of rows.slice(0, limit)) {
      if (row.tenantId === tenantId && (row.paidAt ?? -Infinity) >= since && row.totalMinor !== 0) ids.add(row._id);
    }
  }
  return { ids, capped: ranges.some((rows: Payment[]) => rows.length > limit) };
}

export const getAutomationScorecard = query({
  args: { windowDays: v.number() },
  returns: v.object({
    kinds: v.object({ payment_win: kindStats, additional_payment: kindStats }),
    paidWhopPayments: countValidator,
    winsAwaitingAttendance: queueValidator,
    paymentsWaiting: v.object({ ...queueValidator.fields, billing: queueValidator, closer: queueValidator }),
    unansweredNotMySale: countValidator,
    freshness: v.object({ lastWebhookAt: nullableNumber, lastSuccessfulSweepAt: nullableNumber }),
  }),
  handler: async (ctx, { windowDays }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      throw expectedError("automation.invalid_window", "Choose a window from 1 to 365 days.");
    }
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw expectedError("auth.organization_mismatch", "Organization mismatch");
    const since = Date.now() - windowDays * 86_400_000;
    const connections: Doc<"tenantPaymentConnections">[] = [];
    for (const environment of ["live", "sandbox"] as const) {
      const row = await ctx.db.query("tenantPaymentConnections")
        .withIndex("by_tenantId_and_provider_and_environment", (q) =>
          q.eq("tenantId", tenantId).eq("provider", "whop").eq("environment", environment)).unique();
      if (row) connections.push(row);
    }
    const active = connections.flatMap((row) => row.status === "disconnected" ? [] : [row]);
    const [paid, paymentsWaiting, winsAwaitingAttendance, flags] = await Promise.all([
      paidWindow(ctx, tenantId, connections, since),
      waitingPayments(ctx, tenant, active),
      attendanceOwed(ctx, tenantId),
      ctx.db.query("providerPayments").withIndex("by_tenantId_and_notMySaleAt", (q) =>
        q.eq("tenantId", tenantId).gt("notMySaleAt", undefined)).take(limit + 1),
    ]);
    const [payment_win, additional_payment] = await Promise.all(kinds.map((kind) =>
      readKind(ctx, tenantId, kind, since, paid.ids, paid.capped)));
    return {
      kinds: { payment_win, additional_payment },
      paidWhopPayments: count(paid.ids.size, paid.capped),
      winsAwaitingAttendance,
      paymentsWaiting,
      unansweredNotMySale: count(Math.min(flags.length, limit), flags.length > limit),
      freshness: {
        lastWebhookAt: active[0]?.lastWebhookAt ?? null,
        lastSuccessfulSweepAt: active[0]?.lastSuccessfulSweepAt ?? null,
      },
    };
  },
});
