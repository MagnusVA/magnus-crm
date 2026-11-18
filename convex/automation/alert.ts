import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { transcriptGone } from "../callInsights/retention";
import { loadActiveFollowUpDoc } from "../lib/activeFollowUp";
import { emitDomainEvent } from "../lib/domainEvents";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { PERMISSIONS } from "../lib/permissions";
import { canRecordMeetingOutcome, canTakePayment, loadDealTasks } from "../opportunities/dealGuards";
import { automationCommandRefusalValidator, refuseAutomation } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";
import { alertProposalOf } from "./proposals";
import { effectiveAlertMode } from "./settings";

type ReadCtx = QueryCtx | MutationCtx;
type Decision = Doc<"resultAutomationDecisions">;

const DAY = 86_400_000;
const LIST_LIMIT = 20;
const ALERT_SCAN_LIMIT = 200;
const RULE_VERSION_SCAN_LIMIT = 20;
const PERSON_SCAN_LIMIT = 50;
const HISTORY_LIMIT = 100;

const decisionIdValidator = v.id("resultAutomationDecisions");
const alertRowValidator = v.object({
  decisionId: decisionIdValidator,
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  personName: v.string(),
  callAt: v.number(),
});
const paymentTargetValidator = v.union(
  v.object({ meetingId: v.id("meetings") }),
  v.object({ followUpId: v.id("followUps") }),
);
const answerValidator = v.union(
  v.literal("add_payment"), v.literal("paid_in_whop_by_someone_else"), v.literal("not_paid_yet"),
);
const appliedValidator = v.object({ ok: v.literal(true), alreadyApplied: v.boolean() });
const answerResultValidator = v.union(automationCommandRefusalValidator, v.object({
  ...appliedValidator.fields,
  next: v.union(
    v.null(),
    v.object({ type: v.literal("payment"), target: paymentTargetValidator }),
    v.object({
      type: v.literal("reminder"), purpose: v.literal("payment_owed"),
      opportunityId: v.id("opportunities"), meetingId: v.optional(v.id("meetings")),
    }),
  ),
}));

function alertDecisions(ctx: ReadCtx, tenantId: Id<"tenants">) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", "paid_on_call_alert"));
}

async function loadSubject(ctx: ReadCtx, decision: Decision) {
  const { tenantId, opportunityId, meetingId, leadId } = decision;
  if (decision.kind !== "paid_on_call_alert" || !opportunityId || !meetingId || !leadId ||
      alertProposalOf(decision)?.meetingId !== meetingId) return null;
  const [deal, meeting, person] = await Promise.all([
    ctx.db.get("opportunities", opportunityId),
    ctx.db.get("meetings", meetingId),
    ctx.db.get("leads", leadId),
  ]);
  if (deal?.tenantId !== tenantId || deal.leadId !== leadId || person?.tenantId !== tenantId ||
      person.status === "merged" || meeting?.tenantId !== tenantId || meeting.opportunityId !== opportunityId) return null;
  return { deal, meeting, person };
}

type Subject = NonNullable<Awaited<ReturnType<typeof loadSubject>>>;

function alertRow(decision: Decision, { deal, meeting, person }: Subject) {
  return {
    decisionId: decision._id,
    meetingId: meeting._id,
    opportunityId: deal._id,
    leadId: person._id,
    personName: leadDisplayFromShape({ fullName: person.fullName, leadId: person._id }),
    callAt: meeting.scheduledAt,
  };
}

async function personDeals(ctx: ReadCtx, { tenantId, _id }: Doc<"leads">) {
  return await ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
    q.eq("tenantId", tenantId).eq("leadId", _id)).take(PERSON_SCAN_LIMIT + 1);
}

async function countingPaymentIn(
  ctx: ReadCtx, deals: Doc<"opportunities">[], from: number, through: number,
): Promise<boolean | null> {
  if (through < from) return false;
  for (const deal of deals.slice(0, PERSON_SCAN_LIMIT)) {
    // Recorded and verified count. The status index skips all disputed rows.
    for (const status of ["recorded", "verified"] as const) {
      const payment = await ctx.db.query("paymentRecords")
        .withIndex("by_opportunityId_and_status_and_recordedAt", (q) =>
          q.eq("opportunityId", deal._id).eq("status", status).gte("recordedAt", from).lte("recordedAt", through))
        .first();
      if (payment?.tenantId === deal.tenantId) return true;
    }
  }
  return deals.length > PERSON_SCAN_LIMIT ? null : false;
}

function unresolvedMatch(payment: Doc<"providerPayments">) {
  return !payment.paymentRecordId && payment.totalMinor !== 0 &&
    payment.reviewState !== "historical" && payment.reviewState !== "dismissed" &&
    (payment.status === "paid" || payment.status === "unresolved" || payment.status === "authorized" ||
      payment.status === "pending");
}

async function hasUnresolvedWhopMatch(ctx: ReadCtx, { tenantId, _id }: Doc<"leads">) {
  const [matched, candidates] = await Promise.all([
    ctx.db.query("providerPayments").withIndex("by_tenantId_and_leadId_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", _id)).take(PERSON_SCAN_LIMIT + 1),
    ctx.db.query("providerPayments").withIndex("by_tenantId_and_candidateLeadId_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("candidateLeadId", _id)).take(PERSON_SCAN_LIMIT + 1),
  ]);
  if (matched.some(unresolvedMatch) || candidates.some((row) => !row.leadId && unresolvedMatch(row))) return true;
  return matched.length > PERSON_SCAN_LIMIT || candidates.length > PERSON_SCAN_LIMIT ? null : false;
}

/** A null result means the read limit prevented confirming that no payment exists. */
async function paymentBlocksAlert(ctx: ReadCtx, subject: Subject, now: number, deals?: Doc<"opportunities">[]) {
  const counting = await countingPaymentIn(
    ctx, deals ?? await personDeals(ctx, subject.person), subject.meeting.scheduledAt, now,
  );
  return counting === false ? await hasUnresolvedWhopMatch(ctx, subject.person) : counting;
}

function wasAnswered(decision: Decision) {
  return decision.alertAnswer !== undefined && decision.alertAnswer !== "add_payment";
}

async function hasPriorAnswer(ctx: ReadCtx, decision: Decision) {
  // Re-reading or reprojecting a call can create a new input key for the same question.
  const rows = await ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_and_vetoKey", (q) =>
    q.eq("tenantId", decision.tenantId).eq("vetoKey", decision.vetoKey)).order("desc").take(HISTORY_LIMIT + 1);
  if (rows.some(wasAnswered)) return true;
  return rows.length > HISTORY_LIMIT ? null : false;
}

function isDue(decision: Decision, now: number) {
  return decision.dueAt !== undefined && decision.dueAt <= now;
}

function isCurrentAlertPolicy(tenant: Doc<"tenants">, decision: Decision) {
  return tenant.resultAutomation?.activationVersion === decision.activationVersion &&
    tenant.resultAutomation.paidOnCallAlert?.policyVersion === decision.policyVersion;
}

async function canAnswerSubject(ctx: ReadCtx, decision: Decision, subject: Subject, now: number) {
  if (!decision.noticeUserId || subject.deal.assignedCloserId !== decision.noticeUserId ||
      (subject.deal.humanResultRevision ?? 0) !== decision.humanResultRevision || !decision.recordingId) return false;
  const recording = await ctx.db.get("callRecordings", decision.recordingId);
  return recording?.tenantId === decision.tenantId && recording.meetingId === subject.meeting._id &&
    recording.matchStatus === "matched" && !transcriptGone(recording, now);
}

async function liveCloserSubject(ctx: ReadCtx, decision: Decision, tenant: Doc<"tenants">, now: number) {
  if (decision.tenantId !== tenant._id || decision.state !== "ready" || decision.mode !== "ask" ||
      !isDue(decision, now) || effectiveAlertMode(tenant) !== "on" ||
      !isCurrentAlertPolicy(tenant, decision)) return null;
  const subject = await loadSubject(ctx, decision);
  if (!subject || !await canAnswerSubject(ctx, decision, subject, now) || await hasPriorAnswer(ctx, decision) !== false ||
      await paymentBlocksAlert(ctx, subject, now) !== false) return null;
  return subject;
}

/** Shared with the pinned group when it already has a decision row. */
export async function alertLive(ctx: ReadCtx, decision: Decision, now: number): Promise<boolean> {
  const tenant = await ctx.db.get("tenants", decision.tenantId);
  return tenant !== null && await liveCloserSubject(ctx, decision, tenant, now) !== null;
}

// Reserve room for one more bounded person/payment scan before stopping a list.
async function hasReadBudget(ctx: QueryCtx) {
  const { bytesRead, databaseQueries, documentsRead } = await ctx.meta.getTransactionMetrics();
  return bytesRead.remaining >= 4 * 1024 * 1024 && databaseQueries.remaining >= 300 && documentsRead.remaining >= 500;
}

export const listMyAlerts = query({
  args: {},
  returns: v.array(alertRowValidator),
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant || effectiveAlertMode(tenant) !== "on") return [];
    const decisions = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_noticeUserId_and_state", (q) =>
        q.eq("tenantId", tenantId).eq("noticeUserId", userId).eq("state", "ready"))
      .order("desc").take(ALERT_SCAN_LIMIT);
    const now = Date.now();
    const rows = [];
    for (const decision of decisions) {
      if (decision.kind !== "paid_on_call_alert") continue;
      if (!await hasReadBudget(ctx)) break;
      const subject = await liveCloserSubject(ctx, decision, tenant, now);
      if (subject) rows.push(alertRow(decision, subject));
      if (rows.length === LIST_LIMIT) break;
    }
    return rows;
  },
});

async function paymentTarget(ctx: ReadCtx, { deal, meeting }: Subject) {
  const followUp = await loadActiveFollowUpDoc(ctx, deal._id);
  if (!followUp && meeting.status === "scheduled" && canRecordMeetingOutcome(deal)) {
    return { meetingId: meeting._id };
  }
  if (followUp?.tenantId === deal.tenantId && followUp.closerId === deal.assignedCloserId &&
      followUp.type === "manual_reminder" && followUp.reason !== "stale_opportunity_nudge" &&
      canTakePayment(deal, await loadDealTasks(ctx, deal._id))) return { followUpId: followUp._id };
  return null;
}

export const answerAlert = mutation({
  args: { decisionId: decisionIdValidator, answer: answerValidator },
  returns: answerResultValidator,
  handler: async (ctx, { decisionId, answer }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);
    const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
    if (decision?.tenantId !== tenantId || decision.kind !== "paid_on_call_alert") return refuseAutomation("not_yours");
    const subject = await loadSubject(ctx, decision);
    if (!subject || subject.deal.assignedCloserId !== userId || decision.assignedCloserId !== userId) {
      return refuseAutomation("not_yours");
    }
    if (wasAnswered(decision)) return { ok: true as const, alreadyApplied: true, next: null };
    const now = Date.now();
    // A closer can finish answering a question already displayed before a policy change.
    const wasDisplayed = decision.state === "ready" || (decision.state === "stopped" &&
      (decision.stopCode === "kind_lowered" || decision.stopCode === "paused"));
    if (!wasDisplayed || decision.mode !== "ask" || decision.noticeUserId !== userId || !isDue(decision, now) ||
        !await canAnswerSubject(ctx, decision, subject, now)) return refuseAutomation("alert_closed");
    const alreadyAnswered = await hasPriorAnswer(ctx, decision);
    if (alreadyAnswered) return { ok: true as const, alreadyApplied: true, next: null };
    if (alreadyAnswered === null || await paymentBlocksAlert(ctx, subject, now) !== false) return refuseAutomation("alert_closed");

    if (answer === "add_payment") {
      const target = await paymentTarget(ctx, subject);
      if (!target) return refuseAutomation("not_ready");
      return { ok: true as const, alreadyApplied: false, next: { type: "payment" as const, target } };
    }

    const handoff = answer === "paid_in_whop_by_someone_else";
    const code = handoff ? "paid_by_someone_else" : "not_paid_yet";
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      state: handoff ? "needs_person" : "applied", alertAnswer: code,
      noticeUserId: undefined, stopCode: undefined, resolvedAt: now, resolvedByUserId: userId,
    });
    await emitDomainEvent(ctx, {
      tenantId, source: "closer", entityType: "meeting", entityId: subject.meeting._id,
      eventType: "automation.alert_answered", actorUserId: userId, occurredAt: now,
      metadata: { decisionId, answer: code },
    });
    return {
      ok: true as const, alreadyApplied: false,
      next: handoff ? null : {
        type: "reminder" as const, purpose: "payment_owed" as const, opportunityId: subject.deal._id,
        meetingId: subject.meeting.status === "scheduled" ? subject.meeting._id : undefined,
      },
    };
  },
});

export const listAlertHandoffs = query({
  args: {},
  returns: v.array(v.object({ ...alertRowValidator.fields, ageMs: v.number() })),
  handler: async (ctx) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    const [pending, history] = await Promise.all([
      // An ordinary needs-person proposal has never been answered and has no resolvedAt.
      ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_and_mode_and_state_and_resolvedAt", (q) =>
        q.eq("tenantId", tenantId).eq("mode", "ask").eq("state", "needs_person").gt("resolvedAt", undefined))
        .take(ALERT_SCAN_LIMIT),
      alertDecisions(ctx, tenantId).order("desc").take(ALERT_SCAN_LIMIT),
    ]);
    const decisions = new Map([...pending, ...history].map((decision) => [decision._id, decision]));
    const now = Date.now();
    const rows = [];
    for (const decision of [...decisions.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      // Billing still owns the handoff if a later evaluation superseded the call decision.
      if (decision.alertAnswer !== "paid_by_someone_else") continue;
      if (!await hasReadBudget(ctx)) break;
      const subject = await loadSubject(ctx, decision);
      if (subject && await paymentBlocksAlert(ctx, subject, now) === false) {
        rows.push({ ...alertRow(decision, subject), ageMs: Math.max(0, now - decision.createdAt) });
      }
      if (rows.length === LIST_LIMIT) break;
    }
    return rows;
  },
});

export const resolveAlertHandoff = mutation({
  args: {
    decisionId: decisionIdValidator,
    resolution: v.union(v.literal("payment_found"), v.literal("no_payment_found")),
  },
  returns: v.union(automationCommandRefusalValidator, appliedValidator),
  handler: async (ctx, { decisionId, resolution }) => {
    const { tenantId, userId } = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, tenantId);
    const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
    if (decision?.tenantId !== tenantId || decision.kind !== "paid_on_call_alert") return refuseAutomation("alert_closed");
    if (decision.alertAnswer === "linked" || decision.alertAnswer === "no_payment_found") {
      return { ok: true as const, alreadyApplied: true };
    }
    if (decision.alertAnswer !== "paid_by_someone_else") return refuseAutomation("alert_closed");
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      state: "applied", stopCode: undefined, supersededByDecisionId: undefined,
      alertAnswer: resolution === "payment_found" ? "linked" : resolution,
      resolvedAt: Date.now(), resolvedByUserId: userId,
    });
    return { ok: true as const, alreadyApplied: false };
  },
});

async function alertWindow(ctx: QueryCtx, tenantId: Id<"tenants">, from: number, to: number, asOf: number) {
  const rows: Decision[] = [];
  let version = (await alertDecisions(ctx, tenantId).order("desc").first())?.ruleVersion;
  // The time range is indexed within each rule version. Seek past that version's
  // entire history after reading the window, even if there were no rows in it.
  for (let scanned = 0; version !== undefined && scanned < RULE_VERSION_SCAN_LIMIT; scanned++) {
    const currentVersion = version;
    const matching = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) => {
        const range = q.eq("tenantId", tenantId).eq("kind", "paid_on_call_alert").eq("ruleVersion", currentVersion)
          .gte("createdAt", from);
        return to <= asOf ? range.lt("createdAt", to) : range.lte("createdAt", asOf);
      })
      .order("desc").take(ALERT_SCAN_LIMIT + 1 - rows.length);
    rows.push(...matching);
    if (rows.length > ALERT_SCAN_LIMIT) return { rows: rows.slice(0, ALERT_SCAN_LIMIT), capped: true };
    version = (await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("kind", "paid_on_call_alert").lt("ruleVersion", currentVersion))
      .order("desc").first())?.ruleVersion;
  }
  return { rows, capped: version !== undefined };
}

export const getAlertMetrics = query({
  args: { from: v.number(), to: v.number(), asOf: v.optional(v.number()) },
  returns: v.object({
    wouldRaise: v.number(), falseAlarms: v.number(), open: v.number(), over24Hours: v.number(), capped: v.boolean(),
  }),
  handler: async (ctx, { from, to, asOf = Date.now() }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    const metrics = { wouldRaise: 0, falseAlarms: 0, open: 0, over24Hours: 0, capped: false };
    if (!tenant || ![from, to, asOf].every(Number.isFinite) || from >= to || from > asOf) return metrics;
    const mode = effectiveAlertMode(tenant);
    const { rows, capped } = await alertWindow(ctx, tenantId, from, to, asOf);
    metrics.capped = capped;
    const measured = new Set<string>();
    const open = new Set<string>();
    for (const decision of rows.sort((a, b) => a.createdAt - b.createdAt)) {
      const { createdAt, vetoKey } = decision;
      if (!isDue(decision, asOf) || !alertProposalOf(decision)) continue;
      const measureShadow = decision.mode === "shadow" && !measured.has(vetoKey);
      const handedOff = decision.alertAnswer === "paid_by_someone_else";
      const active = isCurrentAlertPolicy(tenant, decision) && (
        (mode === "shadow" && decision.state === "shadow") ||
        (mode === "on" && decision.state === "ready" && decision.mode === "ask")
      );
      const pending = !open.has(vetoKey) && (handedOff || active);
      if (!measureShadow && !pending) continue;
      if (!await hasReadBudget(ctx)) {
        metrics.capped = true;
        break;
      }
      if (measureShadow) {
        measured.add(vetoKey);
        metrics.wouldRaise++;
      }
      const subject = await loadSubject(ctx, decision);
      if (!subject) continue;
      const deals = await personDeals(ctx, subject.person);
      const found = measureShadow && await countingPaymentIn(ctx, deals, createdAt, Math.min(asOf, createdAt + 7 * DAY));
      if (found === null) metrics.capped = true;
      if (found) metrics.falseAlarms++;
      if (!pending || found) continue;
      const blocked = await paymentBlocksAlert(ctx, subject, asOf, deals);
      if (blocked === null) metrics.capped = true;
      if (blocked !== false) continue;
      if (!handedOff) {
        if (decision.state === "ready" && !await canAnswerSubject(ctx, decision, subject, asOf)) continue;
        const alreadyAnswered = await hasPriorAnswer(ctx, decision);
        if (alreadyAnswered === null) metrics.capped = true;
        if (alreadyAnswered !== false) continue;
      }
      open.add(vetoKey);
      metrics.open++;
      if (asOf - createdAt > DAY) metrics.over24Hours++;
    }
    return metrics;
  },
});
