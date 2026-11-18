import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { callKinds } from "../callInsights/settings";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import { readOpenAudits } from "./audit";
import { automationKindValidator, breakerReasonValidator } from "./schema";
import { PAYMENT_RULE_VERSION } from "./derive";
import { automationKindOf, isCallKind, modeAtLeastAsk, type AutomationKind } from "./proposals";
import { currentRuleVersion, effectiveKindMode } from "./settings";

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

const partialCountValidator = v.object({ count: v.number(), partial: v.boolean() });
const callKindStats = v.object({
  ruleVersion: v.string(),
  proposed: partialCountValidator,
  leftForPerson: partialCountValidator,
  graded: partialCountValidator,
  wrong: partialCountValidator,
  corrected: partialCountValidator,
  shareOfCallsDue: nullableNumber,
});
const closerActivityValidator = v.object({
  partial: v.boolean(),
  rows: v.array(v.object({
    closerId: v.id("users"),
    name: v.string(),
    stops: partialCountValidator,
    unacknowledgedRefusalNotices: partialCountValidator,
    stoppedRefusalNotices: partialCountValidator,
  })),
});

const automaticCounts = v.object({
  payment_win: countValidator, additional_payment: countValidator, call_back: countValidator,
  payment_owed: countValidator, refusal_loss: countValidator,
});
const kinds = ["payment_win", "additional_payment"] as const;
const limit = 500;
type Payment = Doc<"providerPayments">;
type Decision = Doc<"resultAutomationDecisions">;
type Tenant = Doc<"tenants">;

function count(n: number, capped: boolean) {
  return { count: n, capped };
}

function partialCount(n: number, partial: boolean) {
  return { count: Math.min(n, limit), partial: partial || n >= limit };
}

function oldest(current: number | null, time: number) {
  return current === null ? time : Math.min(current, time);
}

async function readKind(
  ctx: QueryCtx, tenantId: Id<"tenants">, kind: AutomationKind, ruleVersion: string, since: number,
  subjects: ReadonlySet<string>, subjectField: "providerPaymentId" | "meetingId", subjectsPartial: boolean,
) {
  const rows = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", kind).eq("ruleVersion", ruleVersion).gte("createdAt", since))
    .take(limit + 1);
  const capped = rows.length > limit;
  let proposed = 0;
  let leftForPerson = 0;
  let graded = 0;
  let wrong = 0;
  let corrected = 0;
  let oldestUngraded: number | null = null;
  const covered = new Set<string>();
  for (const row of rows.slice(0, limit)) {
    if (row.wouldWrite) {
      proposed += 1;
      const subjectId = row[subjectField];
      if (subjectId && subjects.has(subjectId)) covered.add(subjectId);
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
    proposed, leftForPerson, graded, wrong, corrected, capped, read: Math.min(rows.length, limit),
    oldestUngraded,
    share: capped || subjectsPartial || subjects.size === 0 ? null : covered.size / subjects.size,
  };
}

async function readPaymentKind(
  ctx: QueryCtx, tenantId: Id<"tenants">, kind: (typeof kinds)[number], since: number,
  paid: { ids: Set<Id<"providerPayments">>; capped: boolean },
) {
  const stats = await readKind(ctx, tenantId, kind, PAYMENT_RULE_VERSION, since, paid.ids, "providerPaymentId", paid.capped);
  const total = (n: number) => count(n, stats.capped);
  return {
    ruleVersion: PAYMENT_RULE_VERSION,
    proposed: total(stats.proposed), leftForPerson: total(stats.leftForPerson),
    graded: total(stats.graded), wrong: total(stats.wrong), corrected: total(stats.corrected),
    ungraded: { ...total(stats.read - stats.graded), oldestAt: stats.oldestUngraded },
    shareOfPaidWhopPayments: stats.share,
  };
}

async function dueCalls(ctx: QueryCtx, tenantId: Id<"tenants">, since: number, now: number) {
  const meetings = await ctx.db.query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId).gte("scheduledAt", since).lte("scheduledAt", now))
    .take(limit);
  const ids = new Set(meetings.flatMap((meeting) =>
    meeting.status !== "canceled" && meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now ? [meeting._id] : []));
  return { ids, partial: meetings.length === limit };
}

async function readCallKind(
  ctx: QueryCtx, tenant: Tenant, kind: (typeof callKinds)[number], since: number,
  due: Awaited<ReturnType<typeof dueCalls>>,
) {
  const ruleVersion = currentRuleVersion(tenant, kind);
  const stats = await readKind(ctx, tenant._id, kind, ruleVersion, since, due.ids, "meetingId", due.partial);
  const partial = stats.read === limit;
  const total = (n: number) => partialCount(n, partial);
  return {
    ruleVersion,
    proposed: total(stats.proposed), leftForPerson: total(stats.leftForPerson),
    graded: total(stats.graded), wrong: total(stats.wrong), corrected: total(stats.corrected),
    shareOfCallsDue: partial ? null : stats.share,
  };
}

async function readCloserActivity(ctx: QueryCtx, tenantId: Id<"tenants">, since: number) {
  const [stops, unacknowledged, stoppedNotices] = await Promise.all([
    ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_state_stopCode_resolvedAt", (q) =>
      q.eq("tenantId", tenantId).eq("state", "stopped").eq("stopCode", "person_stop").gte("resolvedAt", since)).take(limit),
    ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_kind_state_acknowledgedAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", "refusal_loss").eq("state", "notice").eq("acknowledgedAt", undefined)).take(limit),
    ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_kind_state_resolvedAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", "refusal_loss").eq("state", "stopped").gte("resolvedAt", since)).take(limit),
  ]);
  const byCloser = new Map<Id<"users">, { stops: number; unacknowledged: number; stoppedNotices: number }>();
  function tally(row: Decision, field: "stops" | "unacknowledged" | "stoppedNotices") {
    const closerId = row.noticeUserId ?? row.assignedCloserId;
    if (!closerId) return;
    const totals = byCloser.get(closerId) ?? { stops: 0, unacknowledged: 0, stoppedNotices: 0 };
    totals[field]++;
    byCloser.set(closerId, totals);
  }
  for (const row of stops) if (isCallKind(row.kind)) tally(row, "stops");
  for (const row of unacknowledged) tally(row, "unacknowledged");
  for (const row of stoppedNotices) if (row.noticeRound !== undefined) tally(row, "stoppedNotices");
  const rows = await Promise.all([...byCloser.entries()].slice(0, limit).map(async ([closerId, totals]) => {
    const closer = await ctx.db.get("users", closerId);
    return {
      closerId,
      name: (closer?.tenantId === tenantId && closer.fullName?.trim()) || "Unnamed closer",
      stops: partialCount(totals.stops, stops.length === limit),
      unacknowledgedRefusalNotices: partialCount(totals.unacknowledged, unacknowledged.length === limit),
      stoppedRefusalNotices: partialCount(totals.stoppedNotices, stoppedNotices.length === limit),
    };
  }));
  return {
    rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
    partial: byCloser.size >= limit || [stops, unacknowledged, stoppedNotices].some((rows) => rows.length === limit),
  };
}

async function overdueAutomaticTasks(ctx: QueryCtx, tenantId: Id<"tenants">, now: number) {
  const rows = await ctx.db.query("followUps")
    .withIndex("by_tenantId_source_reason_status_reminderScheduledAt", (q) =>
      q.eq("tenantId", tenantId).eq("createdSource", "system").eq("reason", "call_insights").eq("status", "pending")
        .gt("reminderScheduledAt", undefined).lt("reminderScheduledAt", now))
    .take(limit);
  return partialCount(rows.length, false);
}

async function withoutSecondOpinion(ctx: QueryCtx, applied: Decision[]) {
  const meetings = new Set(applied.slice(0, limit).flatMap((row) =>
    isCallKind(row.kind) && row.appliedVia === "automatic" && row.meetingId ? [row.meetingId] : []));
  const checks = await Promise.all([...meetings].map((meetingId) => ctx.db.query("secondOpinions")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId)).first()));
  return partialCount(checks.filter((check) => check === null).length, applied.length >= limit);
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
    const kind = automationKindOf(row.kind);
    if (kind && row.providerPaymentId && row.noticeUserId && row.activationVersion === tenant.resultAutomation?.activationVersion &&
        row.policyVersion === tenant.resultAutomation?.kinds[kind]?.policyVersion &&
        modeAtLeastAsk(effectiveKindMode(tenant, kind))) closer.add(row.providerPaymentId);
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
    kinds: v.object({
      payment_win: kindStats, additional_payment: kindStats,
      call_back: callKindStats, payment_owed: callKindStats, refusal_loss: callKindStats,
    }),
    callsDue: partialCountValidator,
    closerActivity: closerActivityValidator,
    automaticTasksOverdue: partialCountValidator,
    automaticCallsWithoutSecondOpinion: partialCountValidator,
    paidWhopPayments: countValidator,
    winsAwaitingAttendance: queueValidator,
    paymentsWaiting: v.object({ ...queueValidator.fields, billing: queueValidator, closer: queueValidator }),
    unansweredNotMySale: countValidator,
    auditQueue: queueValidator,
    automaticWrites: automaticCounts,
    breakers: v.array(v.object({
      kind: automationKindValidator, reason: breakerReasonValidator, trippedAt: v.number(),
      decisionId: v.optional(v.id("resultAutomationDecisions")),
    })),
    freshness: v.object({ lastWebhookAt: nullableNumber, lastSuccessfulSweepAt: nullableNumber }),
  }),
  handler: async (ctx, { windowDays }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
      throw expectedError("automation.invalid_window", "Choose a window from 1 to 365 days.");
    }
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw expectedError("auth.organization_mismatch", "Organization mismatch");
    const now = Date.now();
    const since = now - windowDays * 86_400_000;
    const connections: Doc<"tenantPaymentConnections">[] = [];
    for (const environment of ["live", "sandbox"] as const) {
      const row = await ctx.db.query("tenantPaymentConnections")
        .withIndex("by_tenantId_and_provider_and_environment", (q) =>
          q.eq("tenantId", tenantId).eq("provider", "whop").eq("environment", environment)).unique();
      if (row) connections.push(row);
    }
    const active = connections.flatMap((row) => row.status === "disconnected" ? [] : [row]);
    const [
      paid, paymentsWaiting, winsAwaitingAttendance, flags, audits, automaticRows,
      due, closerActivity, automaticTasksOverdue,
    ] = await Promise.all([
      paidWindow(ctx, tenantId, connections, since),
      waitingPayments(ctx, tenant, active),
      attendanceOwed(ctx, tenantId),
      ctx.db.query("providerPayments").withIndex("by_tenantId_and_notMySaleAt", (q) =>
        q.eq("tenantId", tenantId).gt("notMySaleAt", undefined)).take(limit + 1),
      readOpenAudits(ctx, tenantId),
      Promise.all((["applied", "corrected", "undone"] as const).map((state) => ctx.db.query("resultAutomationDecisions")
        .withIndex("by_tenantId_and_mode_and_state_and_resolvedAt", (q) => q.eq("tenantId", tenantId)
          .eq("mode", "automatic").eq("state", state).gte("resolvedAt", since))
        .take(limit + 1))),
      dueCalls(ctx, tenantId, since, now),
      readCloserActivity(ctx, tenantId, since),
      overdueAutomaticTasks(ctx, tenantId, now),
    ]);
    const [[payment_win, additional_payment], [call_back, payment_owed, refusal_loss], automaticCallsWithoutSecondOpinion] =
      await Promise.all([
        Promise.all(kinds.map((kind) => readPaymentKind(ctx, tenantId, kind, since, paid))),
        Promise.all(callKinds.map((kind) => readCallKind(ctx, tenant, kind, since, due))),
        withoutSecondOpinion(ctx, automaticRows[0]),
      ]);
    const capped = automaticRows.some((rows) => rows.length > limit);
    const automaticWrites = {
      payment_win: count(0, capped), additional_payment: count(0, capped), call_back: count(0, capped),
      payment_owed: count(0, capped), refusal_loss: count(0, capped),
    };
    for (const rows of automaticRows) {
      for (const row of rows.slice(0, limit)) {
        const kind = automationKindOf(row.kind);
        if (kind && row.certificateSampleId) automaticWrites[kind].count++;
      }
    }
    const breakers = automationKindValidator.members.flatMap(({ value: kind }) => {
      const breaker = tenant.resultAutomation?.kinds[kind]?.breaker;
      return breaker ? [{ kind, ...breaker }] : [];
    });
    const oldestAudit = audits.rows.reduce<number | null>((current, row) =>
      oldest(current, row.resolvedAt ?? row.createdAt), null);
    return {
      kinds: { payment_win, additional_payment, call_back, payment_owed, refusal_loss },
      callsDue: partialCount(due.ids.size, due.partial),
      closerActivity,
      automaticTasksOverdue,
      automaticCallsWithoutSecondOpinion,
      automaticWrites, breakers, auditQueue: { ...count(audits.rows.length, audits.capped), oldestAt: oldestAudit },
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
