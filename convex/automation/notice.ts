import { makeFunctionReference } from "convex/server";
import { v, type Infer } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { adminCreateManualReminderCore } from "../admin/meetingActions";
import { transcriptGone } from "../callInsights/retention";
import { slotEndAt } from "../callInsights/suggest/state";
import { headerFor } from "../callInsights/trigger";
import { createCallbackTask } from "../closer/followUpMutations";
import { emitDomainEvent } from "../lib/domainEvents";
import { landFollowUp } from "../lib/followUpStart";
import { lossReasonLabel } from "../lib/lossReasonLabel";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { computeLatestActivityAt, transitionOpportunity } from "../lib/opportunityActivity";
import { WEB, type CoreActor } from "../lib/outcomeCores";
import { PERMISSIONS } from "../lib/permissions";
import { addPinnedLine } from "../lib/pinnedLines";
import { insertManualReminder } from "../lib/reminderInsert";
import { sha256Hex, stableJson } from "../lib/stableHash";
import { loadDealOpenTasks } from "../opportunities/dealGuards";
import { dealPosition, RESERVED_LOSS_REASONS } from "../opportunities/stages";
import { isProvisionalPayment, possibleProvisionalPayment } from "../payments/provisionalLookup";
import { automationCommandRefusalValidator, refuseAutomation, type AutomationCommandResult } from "../payments/commandResult";
import { requireTenantUser } from "../requireTenantUser";
import { isOtherProspectsCall } from "../secondOpinion/trigger";
import { scheduleAudit } from "./audit";
import { assertAutomaticAllowed, whopIsFresh } from "./breaker";
import { rederiveCall, scheduleCallEvaluation } from "./callDecisions";
import { recordCallReceipt } from "./callReceipts";
import { noteHumanResult } from "./humanResult";
import { matchedProviderLead } from "./paymentHooks";
import { callEvidenceOf } from "./proposals";
import { stopCodeValidator, taskProposalValidator } from "./schema";
import { effectiveKindMode } from "./settings";

type Decision = Doc<"resultAutomationDecisions">;
type DecisionId = Id<"resultAutomationDecisions">;
type Deal = Doc<"opportunities">;
type Meeting = Doc<"meetings">;
type Tenant = Doc<"tenants">;
type Connection = Doc<"tenantPaymentConnections">;
type StopCode = NonNullable<Decision["stopCode"]>;

const HOUR_MS = 3_600_000;
export const DEFAULT_REFUSAL_NOTICE_HOURS = 48;
export const LATE_WAKEUP_MS = 24 * HOUR_MS;
export const WHOP_FRESH_FOR_REFUSAL_MS = 15 * 60_000;
export const STALE_RETRY_MS = 10 * 60_000;

const QUEUE_LIMIT = 100;
const HISTORY_LIMIT = 100;
const PERSON_LIMIT = 50;
const DEADLINE_BATCH = 20;
const adminRoles = PERMISSIONS["result-automation:lower"];
const noticeRoles = ["closer", ...adminRoles] as const;

const decisionArgs = { decisionId: v.id("resultAutomationDecisions") };
const commandSuccess = { ok: v.literal(true), alreadyApplied: v.boolean() };
const command = v.union(automationCommandRefusalValidator, v.object(commandSuccess));
const closeResult = v.union(automationCommandRefusalValidator, v.object({ ...commandSuccess, ...decisionArgs }));
const stopResult = v.union(automationCommandRefusalValidator, v.object({
  ...commandSuccess, followUpId: v.id("followUps"),
}));

const finalizeRef = makeFunctionReference<"mutation", { decisionId: DecisionId; fromSweep?: boolean }>(
  "automation/notice:finalizeRefusal",
);
const deadlinePageRef = makeFunctionReference<"mutation", { through: number; cursor: string | null }>(
  "automation/notice:refusalDeadlinePage",
);

const viewFields = {
  ...decisionArgs,
  opportunityId: v.id("opportunities"),
  meetingId: v.id("meetings"),
  leadId: v.id("leads"),
  noticeUserId: v.id("users"),
  personName: v.union(v.string(), v.null()),
  createdAt: v.number(),
  ageMs: v.number(),
  noticeHours: v.number(),
  callAt: v.number(),
  acknowledgedAt: v.optional(v.number()),
  dueAt: v.optional(v.number()),
};
const adminView = v.object({ ...viewFields, closerName: v.union(v.string(), v.null()) });

async function readNotice(ctx: QueryCtx, row: Decision, now: number, noticeHours: number) {
  const { opportunityId, meetingId, leadId, noticeUserId } = row;
  if (row.kind !== "refusal_loss" || !opportunityId || !meetingId || !leadId || !noticeUserId) return null;
  const [deal, lead, meeting] = await Promise.all([
    ctx.db.get("opportunities", opportunityId), ctx.db.get("leads", leadId), ctx.db.get("meetings", meetingId),
  ]);
  if (deal?.tenantId !== row.tenantId || deal.assignedCloserId !== noticeUserId ||
      deal.leadId !== leadId || lead?.tenantId !== row.tenantId ||
      meeting?.tenantId !== row.tenantId || meeting.opportunityId !== opportunityId) return null;
  return {
    decisionId: row._id, opportunityId, meetingId, leadId, noticeUserId,
    personName: lead.fullName?.trim() || null,
    createdAt: row.createdAt, ageMs: Math.max(0, now - row.createdAt),
    noticeHours, callAt: meeting.scheduledAt,
    acknowledgedAt: row.acknowledgedAt, dueAt: row.dueAt,
  };
}

function noticeOrder(a: Pick<Decision, "dueAt" | "createdAt">, b: Pick<Decision, "dueAt" | "createdAt">) {
  return (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.createdAt - b.createdAt;
}

export const listMyNotices = query({
  args: {},
  returns: v.object({ notices: v.array(v.object(viewFields)), capped: v.boolean() }),
  handler: async (ctx) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);
    const [tenant, rows] = await Promise.all([
      ctx.db.get("tenants", tenantId),
      ctx.db.query("resultAutomationDecisions")
        .withIndex("by_tenantId_and_noticeUserId_and_state", (q) =>
          q.eq("tenantId", tenantId).eq("noticeUserId", userId).eq("state", "notice"))
        .take(QUEUE_LIMIT + 1),
    ]);
    const noticeHours = tenant?.resultAutomation?.refusalNoticeHours ?? DEFAULT_REFUSAL_NOTICE_HOURS;
    const now = Date.now();
    const notices = await Promise.all(rows.slice(0, QUEUE_LIMIT).sort(noticeOrder).map((row) =>
      readNotice(ctx, row, now, noticeHours)));
    return { notices: notices.filter((row) => row !== null), capped: rows.length > QUEUE_LIMIT };
  },
});

export const listNotices = query({
  args: {},
  returns: v.object({ notices: v.array(adminView), capped: v.boolean() }),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...adminRoles]);
    const [tenant, rows] = await Promise.all([
      ctx.db.get("tenants", tenantId),
      ctx.db.query("resultAutomationDecisions")
        .withIndex("by_tenantId_and_state_and_dueAt", (q) => q.eq("tenantId", tenantId).eq("state", "notice"))
        .take(QUEUE_LIMIT + 1),
    ]);
    const noticeHours = tenant?.resultAutomation?.refusalNoticeHours ?? DEFAULT_REFUSAL_NOTICE_HOURS;
    const now = Date.now();
    const notices = await Promise.all(rows.slice(0, QUEUE_LIMIT).sort(noticeOrder).map(async (row) => {
      const notice = await readNotice(ctx, row, now, noticeHours);
      if (!notice) return null;
      const closer = await ctx.db.get("users", notice.noticeUserId);
      return { ...notice, closerName: closer?.tenantId === tenantId ? closer.fullName?.trim() || null : null };
    }));
    return { notices: notices.filter((row) => row !== null), capped: rows.length > QUEUE_LIMIT };
  },
});

async function loadForActor(ctx: MutationCtx, actor: CoreActor, decisionId: DecisionId) {
  const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (decision?.tenantId !== actor.tenantId || decision.kind !== "refusal_loss" ||
      !decision.opportunityId || !decision.meetingId) return refuseAutomation("not_ready");
  const deal = await ctx.db.get("opportunities", decision.opportunityId);
  if (deal?.tenantId !== actor.tenantId) return refuseAutomation("not_ready");
  if (actor.role === "closer" && deal.assignedCloserId !== actor.userId) return refuseAutomation("not_yours");
  return { ok: true as const, decision, deal, meetingId: decision.meetingId };
}

function actorSource(actor: CoreActor) {
  return actor.role === "closer" ? "closer" as const : "admin" as const;
}

export const acknowledgeNotice = mutation({
  args: decisionArgs,
  returns: command,
  handler: async (ctx, { decisionId }): Promise<AutomationCommandResult> => {
    const actor = await requireTenantUser(ctx, [...noticeRoles]);
    const loaded = await loadForActor(ctx, actor, decisionId);
    if (!loaded.ok) return loaded;
    const { deal, decision } = loaded;
    if (decision.state !== "notice" || decision.mode !== "automatic") return refuseAutomation("not_ready");
    if (!decision.noticeUserId || decision.noticeUserId !== deal.assignedCloserId) return refuseAutomation("stale_preview");
    if (decision.acknowledgedAt !== undefined) return { ok: true, alreadyApplied: true };

    const now = Date.now();
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    const noticeHours = tenant?.resultAutomation?.refusalNoticeHours ?? DEFAULT_REFUSAL_NOTICE_HOURS;
    const dueAt = now + noticeHours * HOUR_MS;
    const acknowledgedAs = actorSource(actor);
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      acknowledgedAt: now, acknowledgedByUserId: actor.userId, acknowledgedAs, noticeHours, dueAt,
    });
    await ctx.scheduler.runAt(dueAt, finalizeRef, { decisionId });
    await emitDomainEvent(ctx, {
      tenantId: actor.tenantId, entityType: "opportunity", entityId: deal._id,
      eventType: "automation.notice_acknowledged", source: acknowledgedAs, actorUserId: actor.userId,
      occurredAt: now, metadata: { decisionId, acknowledgedAs, noticeHours },
    });
    return { ok: true, alreadyApplied: false };
  },
});

const nextStepValidator = v.union(
  v.object({
    kind: v.literal("call_back"),
    contactMethod: taskProposalValidator.fields.contactMethod,
    reminderScheduledAt: v.number(),
  }),
  v.object({ kind: v.literal("keep_open") }),
  v.object({ kind: v.literal("reminder_now"), contactMethod: taskProposalValidator.fields.contactMethod }),
);

async function createStopTask(
  ctx: MutationCtx, actor: CoreActor, deal: Deal, meeting: Meeting, decisionId: DecisionId,
  nextStep: Infer<typeof nextStepValidator>, now: number, closerId: Id<"users">,
) {
  const args = {
    opportunityId: deal._id, meetingId: meeting._id,
    contactMethod: nextStep.kind === "keep_open" ? "call" as const : nextStep.contactMethod,
    reminderScheduledAt: nextStep.kind === "call_back" ? nextStep.reminderScheduledAt : now,
  };
  if (nextStep.kind === "call_back" && deal.stage === "booked") {
    const core = actor.role === "closer" ? createCallbackTask : adminCreateManualReminderCore;
    const { followUpId } = await core(ctx, actor, args, WEB, { decisionId, task: { purpose: "call_back" } });
    // Stop records ordinary held attendance. Only applied receipts own its automation link.
    await patchMeetingLifecycle(ctx, meeting._id, { attendanceSource: undefined, attendanceDecisionId: undefined });
    return followUpId;
  }

  const writer = { source: actorSource(actor), actorUserId: actor.userId };
  const followUpId = await insertManualReminder(ctx, {
    ...writer, opportunity: deal, closerId, sourceMeetingId: meeting._id,
    contactMethod: args.contactMethod, reminderScheduledAt: args.reminderScheduledAt,
    reason: "call_insights", task: { purpose: "call_back" }, automationDecisionId: decisionId, now,
  });
  await landFollowUp(ctx, deal._id, deal.stage === "follow_up" ? "stay" : "move", {
    ...writer, occurredAt: now, decisionId,
  });
  await completeMeetingForOutcome(ctx, {
    meetingId: meeting._id, opportunityId: deal._id, toMeetingStatus: "held", recordedAt: now,
  });
  return followUpId;
}

export const stopNotice = mutation({
  args: { ...decisionArgs, nextStep: nextStepValidator },
  returns: stopResult,
  handler: async (ctx, { decisionId, nextStep }): Promise<AutomationCommandResult<{ followUpId: Id<"followUps"> }>> => {
    const actor = await requireTenantUser(ctx, [...noticeRoles]);
    const loaded = await loadForActor(ctx, actor, decisionId);
    if (!loaded.ok) return loaded;
    const { deal, decision, meetingId } = loaded;
    if (decision.state === "stopped" && decision.stopCode === "person_stop" && decision.stopNextStep) {
      return { ok: true, alreadyApplied: true, followUpId: decision.stopNextStep.followUpId };
    }
    if (decision.state !== "notice" && decision.state !== "ready") return refuseAutomation("not_ready");
    const closerId = deal.assignedCloserId;
    const position = dealPosition(deal.stage, deal.outcome);
    if (!closerId || (position !== "booked" && position !== "follow_up")) return refuseAutomation("deal_not_open");

    const now = Date.now();
    if (nextStep.kind === "call_back" &&
        (!Number.isFinite(nextStep.reminderScheduledAt) || nextStep.reminderScheduledAt <= now)) {
      return refuseAutomation("time_past");
    }
    const meeting = await ctx.db.get("meetings", meetingId);
    if (meeting?.tenantId !== actor.tenantId || meeting.opportunityId !== deal._id ||
        meeting.status !== "scheduled" || meeting.scheduledAt > now) return refuseAutomation("meeting_not_open");
    if ((await loadDealOpenTasks(ctx, deal._id)).hasOpenTask) return refuseAutomation("open_task");

    const followUpId = await createStopTask(ctx, actor, deal, meeting, decisionId, nextStep, now, closerId);
    const kind = nextStep.kind === "call_back" ? "call_back" : "reminder_now";
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      state: "stopped", stopCode: "person_stop", resolvedAt: now, resolvedByUserId: actor.userId,
      stopNextStep: { kind, followUpId },
    });
    await noteHumanResult(ctx, deal._id, actor, { consumeDecisionId: decisionId });
    await emitDomainEvent(ctx, {
      tenantId: actor.tenantId, entityType: "opportunity", entityId: deal._id,
      eventType: "automation.notice_stopped", source: actorSource(actor), actorUserId: actor.userId,
      occurredAt: now, metadata: { decisionId, nextStep: kind },
    });
    return { ok: true, alreadyApplied: false, followUpId };
  },
});

// The build contract's Stop command also serves the refusal ask.
export const stopRefusal = stopNotice;

export const closeNow = mutation({
  args: decisionArgs,
  returns: closeResult,
  handler: async (ctx, { decisionId }): Promise<AutomationCommandResult<{ decisionId: DecisionId }>> => {
    const actor = await requireTenantUser(ctx, [...noticeRoles]);
    const loaded = await loadForActor(ctx, actor, decisionId);
    if (!loaded.ok) return loaded;
    const { decision } = loaded;
    if (decision.state !== "notice" &&
        !(decision.state === "applied" && decision.appliedVia === "meeting_confirm" && decision.noticeRound !== undefined)) {
      return refuseAutomation("not_ready");
    }
    return ctx.runMutation(api.automation.refusal.confirmRefusal, {
      decisionId, expectedInputKey: decision.inputKey,
    });
  },
});

function vetoRows(ctx: MutationCtx, decision: Decision) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_vetoKey", (q) => q.eq("tenantId", decision.tenantId).eq("vetoKey", decision.vetoKey))
    .take(HISTORY_LIMIT + 1);
}

function isActiveVeto(row: Decision) {
  return row.stopCode === "person_stop" && row.vetoReleasedAt === undefined;
}

export const releaseVeto = mutation({
  args: decisionArgs,
  returns: command,
  handler: async (ctx, { decisionId }): Promise<AutomationCommandResult> => {
    const actor = await requireTenantUser(ctx, [...adminRoles]);
    const loaded = await loadForActor(ctx, actor, decisionId);
    if (!loaded.ok) return loaded;
    const { decision, meetingId } = loaded;
    if (decision.state !== "stopped" || decision.stopCode !== "person_stop") return refuseAutomation("not_ready");
    if (decision.vetoReleasedAt !== undefined) return { ok: true, alreadyApplied: true };
    const rows = await vetoRows(ctx, decision);
    if (rows.length > HISTORY_LIMIT) return refuseAutomation("needs_review");
    const active = rows.filter(isActiveVeto);
    const now = Date.now();
    for (const row of active) {
      await ctx.db.patch("resultAutomationDecisions", row._id, {
        vetoReleasedAt: now, vetoReleasedByUserId: actor.userId,
      });
    }
    await scheduleCallEvaluation(ctx, await ctx.db.get("tenants", actor.tenantId), meetingId, "settings");
    return { ok: true, alreadyApplied: false };
  },
});

/** Capture the deal position when the notice is first derived, before anyone acknowledges it. */
export async function captureRefusalNoticeBefore(
  ctx: MutationCtx, opportunityId: Id<"opportunities">, meeting: Meeting,
): Promise<Decision["callBefore"]> {
  const deal = await ctx.db.get("opportunities", opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId || meeting.opportunityId !== deal._id ||
      meeting.status !== "scheduled") return undefined;
  const position = dealPosition(deal.stage, deal.outcome);
  if (position !== "booked" && position !== "follow_up") return undefined;
  const person = await ctx.db.get("leads", deal.leadId);
  if (person?.tenantId !== deal.tenantId || person.status === "merged") return undefined;
  return {
    position, meetingId: meeting._id, meetingStatus: meeting.status,
    identityReviewRevision: person.identityReviewRevision,
    latestActivityAt: deal.latestActivityAt ?? computeLatestActivityAt(deal),
  };
}

const finalizeResult = v.union(
  v.object({ status: v.literal("noop") }),
  v.object({ status: v.literal("withdrawn"), code: stopCodeValidator }),
  v.object({ status: v.literal("restarted"), decisionId: v.id("resultAutomationDecisions") }),
  v.object({ status: v.literal("retry"), retryAt: v.number() }),
  v.object({ status: v.literal("applied"), ...decisionArgs, alreadyApplied: v.boolean() }),
);
type FinalizeResult = Infer<typeof finalizeResult>;

async function withdraw(ctx: MutationCtx, decision: Decision, code: StopCode, now: number) {
  await ctx.db.patch("resultAutomationDecisions", decision._id, {
    state: code === "input_changed" ? "superseded" : "stopped", stopCode: code, resolvedAt: now,
  });
  if (decision.opportunityId && decision.noticeUserId) {
    await addPinnedLine(ctx, {
      tenantId: decision.tenantId, userId: decision.noticeUserId, kind: "refusal_notice_withdrawn",
      opportunityId: decision.opportunityId, meetingId: decision.meetingId, decisionId: decision._id, createdAt: now,
    });
  }
  return { status: "withdrawn" as const, code };
}

async function replacement(
  ctx: MutationCtx, decision: Decision, fields: {
    inputKey: string; state: "notice" | "ready"; closerId: Id<"users">; now: number;
    meetingId: Id<"meetings">; opportunityId: Id<"opportunities">;
  },
) {
  // A fresh round may have exactly the same rule inputs. Keep one canonical
  // key for the evaluator, while the retired row keeps its ID and history.
  if (fields.inputKey === decision.inputKey) {
    const retiredKey = await sha256Hex(stableJson(["retired_notice", decision.inputKey, decision._id]));
    await ctx.db.patch("resultAutomationDecisions", decision._id, { inputKey: retiredKey });
  }
  const id = await ctx.db.insert("resultAutomationDecisions", {
    tenantId: decision.tenantId, kind: "refusal_loss",
    state: fields.state, mode: fields.state === "notice" ? "automatic" : "ask",
    inputKey: fields.inputKey, vetoKey: decision.vetoKey, ruleVersion: decision.ruleVersion,
    policyVersion: decision.policyVersion, activationVersion: decision.activationVersion,
    humanResultRevision: decision.humanResultRevision, wouldWrite: decision.wouldWrite, gates: decision.gates,
    leadId: decision.leadId, opportunityId: fields.opportunityId, meetingId: fields.meetingId,
    assignedCloserId: fields.closerId, noticeUserId: fields.closerId, confirmRoute: "meeting",
    proposal: { type: "refusal", closerId: fields.closerId, meetingId: fields.meetingId },
    evidence: decision.evidence, runId: decision.runId, recordingId: decision.recordingId,
    noticeRound: fields.state === "notice" ? (decision.noticeRound ?? 1) + 1 : undefined,
    callBefore: fields.state === "notice" ? decision.callBefore : undefined,
    createdAt: fields.now,
  });
  await ctx.db.patch("resultAutomationDecisions", decision._id, { supersededByDecisionId: id });
  return id;
}

async function restart(
  ctx: MutationCtx, decision: Decision, code: "late_wakeup" | "closer_changed", now: number,
): Promise<FinalizeResult> {
  const stopped = await withdraw(ctx, decision, code, now);
  if (!decision.opportunityId || !decision.meetingId) return stopped;
  const deal = await ctx.db.get("opportunities", decision.opportunityId);
  const closer = deal?.assignedCloserId && await ctx.db.get("users", deal.assignedCloserId);
  if (deal?.tenantId !== decision.tenantId || closer?.tenantId !== decision.tenantId ||
      closer.role !== "closer" || !closer.isActive) return stopped;

  let inputKey = decision.inputKey;
  if (closer._id !== decision.noticeUserId) {
    const { derived } = await rederiveCall(ctx, decision, now);
    if (!derived?.wouldWrite || derived.noticeUserId !== closer._id) return stopped;
    inputKey = await sha256Hex(stableJson(derived.inputTuple));
    const existing = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_inputKey", (q) => q.eq("tenantId", decision.tenantId).eq("inputKey", inputKey))
      .unique();
    if (existing) return stopped;
  }
  const decisionId = await replacement(ctx, decision, {
    inputKey, state: "notice", closerId: closer._id, meetingId: decision.meetingId,
    opportunityId: decision.opportunityId, now,
  });
  return { status: "restarted", decisionId };
}

async function withdrawToAsk(ctx: MutationCtx, tenant: Tenant, decision: Decision, code: StopCode, now: number) {
  const result = await withdraw(ctx, decision, code, now);
  const { meetingId, opportunityId, noticeUserId } = decision;
  if (!meetingId || !opportunityId || !noticeUserId) return result;
  const mode = effectiveKindMode(tenant, "refusal_loss");
  if (mode !== "ask" && mode !== "automatic") return result;
  const current = await rederiveCall(ctx, decision, now);
  if (current.same && current.derived?.askable) {
    await replacement(ctx, decision, {
      inputKey: decision.inputKey, state: "ready", closerId: noticeUserId, meetingId, opportunityId, now,
    });
  } else if (mode === "ask") {
    await scheduleCallEvaluation(ctx, tenant, meetingId, "settings");
  }
  return result;
}

async function hasNewerMeeting(ctx: MutationCtx, deals: Deal[], meeting: Meeting) {
  for (const deal of deals) {
    for (const status of ["scheduled", "held", "no_show"] as const) {
      const row = await ctx.db.query("meetings")
        .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
          q.eq("opportunityId", deal._id).eq("status", status).gt("scheduledAt", meeting.scheduledAt))
        .first();
      if (row?.tenantId === meeting.tenantId) return true;
    }
  }
  return false;
}

async function whopConnections(ctx: MutationCtx, tenantId: Tenant["_id"]) {
  const rows = await Promise.all((["live", "sandbox"] as const).map((environment) =>
    ctx.db.query("tenantPaymentConnections")
      .withIndex("by_tenantId_and_provider_and_environment", (q) =>
        q.eq("tenantId", tenantId).eq("provider", "whop").eq("environment", environment))
      .unique()));
  return rows.filter((row) => row !== null);
}

async function paymentHold(
  ctx: MutationCtx, person: Doc<"leads">, personDeals: Deal[], connections: Connection[],
): Promise<"payment_found" | "input_changed" | null> {
  for (const personDeal of personDeals) {
    for (const status of ["recorded", "verified"] as const) {
      const row = await ctx.db.query("paymentRecords")
        .withIndex("by_opportunityId_and_status_and_recordedAt", (q) =>
          q.eq("opportunityId", personDeal._id).eq("status", status))
        .first();
      if (row?.tenantId === person.tenantId) return "payment_found";
    }
  }
  const { tenantId, _id: leadId } = person;
  const [resolved, candidates] = await Promise.all([
    ctx.db.query("providerPayments").withIndex("by_tenantId_and_leadId_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId)).take(PERSON_LIMIT + 1),
    ctx.db.query("providerPayments").withIndex("by_tenantId_and_candidateLeadId_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("candidateLeadId", leadId)).take(PERSON_LIMIT + 1),
  ]);
  if (resolved.length > PERSON_LIMIT || candidates.length > PERSON_LIMIT) return "input_changed";
  const possible = [...resolved, ...candidates.filter((row) => row.leadId === undefined)].find((row) => {
    const connection = connections.find(({ _id }) => _id === row.connectionId);
    const paymentAt = row.paidAt ?? row.sourceCreatedAt;
    return paymentAt >= (connection?.autoImportAfter ?? -Infinity) &&
      ((row.status === "paid" && row.totalMinor !== 0 && row.reviewState !== "historical" &&
        row.reviewState !== "dismissed") || isProvisionalPayment(row));
  }) ?? await possibleProvisionalPayment(ctx, person);
  if (!possible) return null;
  if (possible !== "unknown" && await matchedProviderLead(ctx, possible) === leadId) return "payment_found";
  return "input_changed";
}

async function applyLoss(
  ctx: MutationCtx, decision: Decision, deal: Deal, meeting: Meeting, closerId: Id<"users">,
  position: "booked" | "follow_up", sampleId: Id<"automationSamples">, now: number,
): Promise<FinalizeResult> {
  const latestActivityAt = deal.latestActivityAt ?? computeLatestActivityAt(deal);
  await completeMeetingForOutcome(ctx, {
    meetingId: meeting._id, opportunityId: deal._id, toMeetingStatus: "held", recordedAt: now,
    extraMeetingPatch: { attendanceSource: "call_insights", attendanceDecisionId: decision._id },
  });
  await transitionOpportunity(ctx, deal._id, {
    to: { stage: "closed", outcome: "lost" },
    fields: {
      updatedAt: now, lostAt: now, lostReason: RESERVED_LOSS_REASONS.call_refusal,
      lostByUserId: undefined, latestActivityAt,
    },
    source: "system", reason: lossReasonLabel(RESERVED_LOSS_REASONS.call_refusal) ?? undefined,
    metadata: { decisionId: decision._id }, occurredAt: now,
  });
  await recordCallReceipt(ctx, {
    decisionId: decision._id, appliedVia: "automatic", now,
    callBefore: { position, meetingId: meeting._id, meetingStatus: "scheduled", latestActivityAt },
  });
  await ctx.db.patch("resultAutomationDecisions", decision._id, { certificateSampleId: sampleId });
  await scheduleAudit(ctx, decision, now);
  await addPinnedLine(ctx, {
    tenantId: deal.tenantId, userId: closerId, kind: "refusal_recorded",
    opportunityId: deal._id, meetingId: meeting._id, decisionId: decision._id,
    dealPositionAfter: "lost", createdAt: now,
  });
  return { status: "applied", decisionId: decision._id, alreadyApplied: false };
}

export const finalizeRefusal = internalMutation({
  args: { ...decisionArgs, fromSweep: v.optional(v.boolean()) },
  returns: finalizeResult,
  handler: async (ctx, { decisionId, fromSweep }): Promise<FinalizeResult> => {
    const now = Date.now();
    const decision = await ctx.db.get("resultAutomationDecisions", decisionId);
    if (decision?.kind !== "refusal_loss") return { status: "noop" };
    if (decision.state === "applied" && decision.appliedVia === "automatic") {
      return { status: "applied", decisionId, alreadyApplied: true };
    }

    // 1–2. The acknowledged round's deadline is necessary, but expires after a day.
    const { acknowledgedAt, acknowledgedByUserId, acknowledgedAs, noticeHours, dueAt } = decision;
    if (decision.state !== "notice" || acknowledgedAt === undefined || !acknowledgedByUserId ||
        !acknowledgedAs || (acknowledgedAs === "closer" && acknowledgedByUserId !== decision.noticeUserId) ||
        noticeHours === undefined || !Number.isFinite(noticeHours) || noticeHours < 24 || dueAt === undefined || dueAt !== acknowledgedAt + noticeHours * HOUR_MS || now < dueAt) {
      return { status: "noop" };
    }
    const person = decision.leadId && await ctx.db.get("leads", decision.leadId);
    if (person?.tenantId === decision.tenantId &&
        (person.identityReviewRevision ?? 0) !== (decision.callBefore?.identityReviewRevision ?? 0)) {
      return withdraw(ctx, decision, "human_result", now);
    }
    if (now - dueAt > LATE_WAKEUP_MS) return restart(ctx, decision, "late_wakeup", now);

    // 3–5. Tenant switch, serving rule and certificate, and both policy fences.
    const tenant = await ctx.db.get("tenants", decision.tenantId);
    const settings = tenant?.resultAutomation;
    if (tenant?.status !== "active" || !settings?.enabled) return withdraw(ctx, decision, "paused", now);
    const allowance = await assertAutomaticAllowed(ctx, { tenantId: tenant._id, kind: "refusal_loss", decision }, now);
    const policy = settings.kinds.refusal_loss;
    if (!allowance.ok && allowance.gate !== "kind_off") return withdrawToAsk(ctx, tenant, decision, "certificate_lapsed", now);
    if (effectiveKindMode(tenant, "refusal_loss") !== "automatic" || decision.mode !== "automatic" || !decision.wouldWrite) {
      return withdrawToAsk(ctx, tenant, decision, "kind_lowered", now);
    }
    if (policy?.policyVersion !== decision.policyVersion || settings.activationVersion !== decision.activationVersion ||
        !allowance.ok) return withdraw(ctx, decision, "kind_lowered", now);

    // 6–7. The same recording, published run, meeting and person, with retained words.
    const { recordingId, runId, meetingId, opportunityId, leadId } = decision;
    const evidence = callEvidenceOf(decision);
    if (!recordingId || !runId || !meetingId || !opportunityId || !leadId ||
        evidence?.recordingId !== recordingId || evidence.runId !== runId) {
      return withdraw(ctx, decision, "recording_moved", now);
    }
    const [recording, run, header, meeting, deal] = await Promise.all([
      ctx.db.get("callRecordings", recordingId), ctx.db.get("callInsightRuns", runId), headerFor(ctx, recordingId),
      ctx.db.get("meetings", meetingId), ctx.db.get("opportunities", opportunityId),
    ]);
    if (recording?.tenantId !== tenant._id || recording.matchStatus !== "matched" || recording.meetingId !== meetingId ||
        !header?.active || header.tenantId !== tenant._id || header.meetingId !== meetingId ||
        header.publishedRunId !== runId || run?.tenantId !== tenant._id || run.meetingId !== meetingId ||
        run.recordingId !== recordingId || run.generation !== evidence.generation || run.status !== "answered" ||
        run.purpose !== "serve" || person?.tenantId !== tenant._id || person.status === "merged" ||
        (deal && deal.leadId !== leadId) ||
        (meeting && meeting.tenantId === tenant._id && await isOtherProspectsCall(ctx, meeting, recording))) {
      return withdraw(ctx, decision, "recording_moved", now);
    }
    if (transcriptGone(recording, now) || run.quotesPurgedAt !== undefined || header.quotesPurgedAt !== undefined) {
      return withdraw(ctx, decision, "transcript_gone", now);
    }

    // 8–11. The booked facts, human work, durable veto and assigned closer.
    const position = deal && dealPosition(deal.stage, deal.outcome);
    if (deal?.tenantId !== tenant._id || meeting?.tenantId !== tenant._id || meeting.opportunityId !== deal._id ||
        meeting.status !== "scheduled" || meeting.scheduledAt !== header.scheduledAt ||
        slotEndAt(meeting) !== evidence.slotEndedAt || decision.callBefore?.meetingId !== meetingId ||
        (position !== "booked" && position !== "follow_up") || position !== decision.callBefore.position) {
      return withdraw(ctx, decision, "deal_closed", now);
    }
    if ((deal.humanResultRevision ?? 0) !== decision.humanResultRevision ||
        (await loadDealOpenTasks(ctx, deal._id)).hasOpenTask) return withdraw(ctx, decision, "human_result", now);
    const history = await vetoRows(ctx, decision);
    if (history.length > HISTORY_LIMIT || history.some(isActiveVeto)) return withdraw(ctx, decision, "person_stop", now);
    const closerId = deal.assignedCloserId;
    if (!closerId || closerId !== decision.noticeUserId) return restart(ctx, decision, "closer_changed", now);

    // 12–14. A new booking or any money for this person stands down a loss.
    const personDeals = await ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenant._id).eq("leadId", deal.leadId)).take(PERSON_LIMIT + 1);
    if (personDeals.length > PERSON_LIMIT || await hasNewerMeeting(ctx, personDeals, meeting)) {
      return withdraw(ctx, decision, "newer_meeting", now);
    }
    const connections = await whopConnections(ctx, tenant._id);
    const paymentStop = await paymentHold(ctx, person, personDeals, connections);
    if (paymentStop) return withdraw(ctx, decision, paymentStop, now);
    const stale = connections.filter((connection) => connection.status !== "disconnected" &&
      (!whopIsFresh(connection, now) || (connection.lastSuccessfulSweepAt ?? -Infinity) < now - WHOP_FRESH_FOR_REFUSAL_MS));
    if (stale.length > 0) {
      for (const connection of stale) {
        if (connection.status === "connected") {
          await ctx.scheduler.runAfter(0, internal.payments.reconcile.sweepRecent, { connectionId: connection._id, through: now });
        }
      }
      const retryAt = now + STALE_RETRY_MS;
      // The recurring sweep repairs lost jobs without starting parallel retry chains.
      if (!fromSweep) await ctx.scheduler.runAt(retryAt, finalizeRef, { decisionId });
      return { status: "retry", retryAt };
    }

    // 15. Re-run the same wordless derivation inside the transaction that can write.
    const current = await rederiveCall(ctx, decision, now);
    if (!current.same || !current.derived?.wouldWrite) return withdraw(ctx, decision, "input_changed", now);
    return applyLoss(ctx, decision, deal, meeting, closerId, position, allowance.sampleId, now);
  },
});

/** Start a deadline pass once per sweep, regardless of whether any tenant is enabled. */
export async function scheduleRefusalDeadlinePass(ctx: MutationCtx, through: number): Promise<void> {
  await ctx.scheduler.runAfter(0, deadlinePageRef, { through, cursor: null });
}

export const refusalDeadlinePage = internalMutation({
  args: { through: v.number(), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { through, cursor }) => {
    const page = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_state_and_dueAt", (q) => q.eq("state", "notice").gt("dueAt", undefined).lte("dueAt", through))
      .paginate({ cursor, numItems: DEADLINE_BATCH, maximumBytesRead: 256 * 1024 });
    for (const row of page.page) await ctx.scheduler.runAfter(0, finalizeRef, { decisionId: row._id, fromSweep: true });
    if (!page.isDone) await ctx.scheduler.runAfter(0, deadlinePageRef, { through, cursor: page.continueCursor });
    return null;
  },
});
