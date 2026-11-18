import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { adminCreateManualReminderCore, checkAdminManualReminderAllowed } from "../admin/meetingActions";
import { canSeeMeeting, insightsViewer, visibleHeader, type InsightsViewer } from "../callInsights/access";
import { maskEvidenceQuotes } from "../callInsights/maintenance";
import { transcriptGone } from "../callInsights/retention";
import { headerFor } from "../callInsights/trigger";
import { quoteValidator, statementKindValidator } from "../callInsights/validators";
import { checkCallbackTaskAllowed, createCallbackTask } from "../closer/followUpMutations";
import { refusalByline, lossReasonLabel } from "../lib/lossReasonLabel";
import { computeLatestActivityAt } from "../lib/opportunityActivity";
import { WEB, type CoreActor } from "../lib/outcomeCores";
import { PERMISSIONS } from "../lib/permissions";
import { canRecordMeetingOutcome, loadDealOpenTasks } from "../opportunities/dealGuards";
import { dealPosition, RESERVED_LOSS_REASONS } from "../opportunities/stages";
import { automationCommandRefusalValidator, refuseAutomation } from "../payments/commandResult";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { rederiveCall } from "./callDecisions";
import { recordCallReceipt } from "./callReceipts";
import { stopDecision } from "./decisions";
import { noteHumanResult } from "./humanResult";
import { callEvidenceOf, isCallKind, modeAtLeastAsk, refusalProposalOf, taskProposalOf } from "./proposals";
import { automationGateValidator, refusalProposalValidator, taskProposalValidator } from "./schema";
import { effectiveKindMode } from "./settings";
import { correctedNextStepForWithdrawal } from "./taskCorrections";

type Decision = Doc<"resultAutomationDecisions">;
type Deal = Doc<"opportunities">;
type Meeting = Doc<"meetings">;
type Task = Doc<"followUps">;

export const CALL_ASK_ROLES = ["closer", ...PERMISSIONS["result-automation:lower"]] as const;
export const confirmCallArgs = { decisionId: v.id("resultAutomationDecisions"), expectedInputKey: v.string() };
export const callCommandSuccess = { ok: v.literal(true), alreadyApplied: v.boolean() };

const callKindValidator = v.union(v.literal("call_back"), v.literal("payment_owed"), v.literal("refusal_loss"));
const quotesValidator = v.array(v.object({ ...quoteValidator.fields, kind: statementKindValidator }));
const askStateValidator = v.union(v.literal("ready"), v.literal("needs_person"), v.literal("notice"));
const taskViewValidator = v.object({
  followUpId: v.id("followUps"),
  purpose: taskProposalValidator.fields.purpose,
  contactMethod: taskProposalValidator.fields.contactMethod,
  reminderScheduledAt: v.number(),
  expectedAmountMinor: v.optional(v.number()),
  expectedCurrency: v.optional(v.string()),
  promisedPaymentAt: v.optional(v.number()),
  declineCode: v.optional(v.string()),
  status: v.union(v.literal("pending"), v.literal("completed"), v.literal("booked"), v.literal("expired")),
});
const noticeValidator = v.object({
  round: v.optional(v.number()),
  hours: v.number(),
  dueAt: v.optional(v.number()),
  acknowledgedAt: v.optional(v.number()),
  acknowledgedByUserId: v.optional(v.id("users")),
  acknowledgedByName: v.union(v.string(), v.null()),
  acknowledgedAs: v.optional(v.union(v.literal("closer"), v.literal("admin"))),
});

async function loadCallDecision(ctx: MutationCtx, actor: CoreActor, id: Id<"resultAutomationDecisions">) {
  const decision = await ctx.db.get("resultAutomationDecisions", id);
  if (!decision?.opportunityId || !decision.meetingId ||
      decision.tenantId !== actor.tenantId || !isCallKind(decision.kind)) {
    return refuseAutomation("not_ready");
  }
  const deal = await ctx.db.get("opportunities", decision.opportunityId);
  if (!deal || deal.tenantId !== actor.tenantId) return refuseAutomation("not_ready");
  if (actor.role === "closer" && deal.assignedCloserId !== actor.userId) return refuseAutomation("not_yours");
  return { ok: true as const, decision, deal, meetingId: decision.meetingId, kind: decision.kind };
}

// Compare the preview and the facts again in the same transaction as the save.
export async function prepareCallConfirm(
  ctx: MutationCtx, actor: CoreActor, { decisionId, expectedInputKey }: {
    decisionId: Id<"resultAutomationDecisions">; expectedInputKey: string;
  }, route: "task" | "refusal",
) {
  const loaded = await loadCallDecision(ctx, actor, decisionId);
  if (!loaded.ok) return loaded;
  const { decision, deal, kind, meetingId } = loaded;
  if ((kind === "refusal_loss") !== (route === "refusal")) return refuseAutomation("not_ready");
  if (decision.inputKey !== expectedInputKey) return refuseAutomation("stale_preview");
  if (decision.state === "applied") return { ...loaded, alreadyApplied: true as const };

  const tenant = await ctx.db.get("tenants", actor.tenantId);
  if (!tenant || !modeAtLeastAsk(effectiveKindMode(tenant, kind))) return refuseAutomation("kind_off");
  if (decision.state === "superseded" ||
      (decision.state === "stopped" && decision.stopCode !== "person_stop")) {
    return refuseAutomation("stale_preview");
  }
  if (decision.state !== "ready" && !(route === "refusal" && decision.state === "notice")) {
    return refuseAutomation("not_ready");
  }

  const now = Date.now();
  const [meeting, current] = await Promise.all([
    ctx.db.get("meetings", meetingId),
    rederiveCall(ctx, decision, now),
  ]);
  const position = dealPosition(deal.stage, deal.outcome);
  if (!meeting || meeting.tenantId !== actor.tenantId || meeting.opportunityId !== deal._id ||
      meeting.status !== "scheduled" || (position !== "booked" && position !== "follow_up") ||
      (deal.humanResultRevision ?? 0) !== decision.humanResultRevision ||
      !current.same || !current.derived?.askable) {
    await stopDecision(ctx, decisionId, null, "input_changed");
    return refuseAutomation("stale_preview");
  }

  const callBefore = {
    position,
    meetingId,
    meetingStatus: meeting.status,
    latestActivityAt: deal.latestActivityAt ?? computeLatestActivityAt(deal),
  };
  return { ...loaded, alreadyApplied: false as const, callBefore, now };
}

export async function finishCallConfirm(
  ctx: MutationCtx, actor: CoreActor,
  { decision, deal, now, callBefore }: {
    decision: Decision; deal: Deal; now: number; callBefore: NonNullable<Decision["callBefore"]>;
  },
  followUpId?: Id<"followUps">,
) {
  if (decision.mode === "automatic") {
    // A person may confirm during automatic mode. The resulting write is an ask receipt.
    await ctx.db.patch("resultAutomationDecisions", decision._id, { mode: "ask" });
  }
  await recordCallReceipt(ctx, {
    decisionId: decision._id, appliedVia: "meeting_confirm", approverUserId: actor.userId,
    followUpId, callBefore, now,
  });
  await noteHumanResult(ctx, deal._id, actor, { consumeDecisionId: decision._id });
}

export const confirmCallDecision = mutation({
  args: confirmCallArgs,
  returns: v.union(automationCommandRefusalValidator, v.object({
    ...callCommandSuccess, decisionId: v.id("resultAutomationDecisions"), followUpId: v.id("followUps"),
  })),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...CALL_ASK_ROLES]);
    const result = await prepareCallConfirm(ctx, actor, args, "task");
    if (!result.ok) return result;
    const { decision, deal, meetingId, kind } = result;
    const decisionId = decision._id;
    if (result.alreadyApplied) {
      if (!decision.writtenFollowUpId) throw new Error("Applied call task has no receipt");
      return { ok: true as const, alreadyApplied: true, decisionId, followUpId: decision.writtenFollowUpId };
    }

    const proposal = taskProposalOf(decision);
    if (!proposal || proposal.meetingId !== meetingId || proposal.purpose !== kind) return refuseAutomation("not_ready");
    const { reminderScheduledAt, contactMethod, ...task } = proposal;
    const coreArgs = { opportunityId: deal._id, meetingId, reminderScheduledAt, contactMethod };
    const closer = actor.role === "closer";
    const check = closer ? checkCallbackTaskAllowed : checkAdminManualReminderAllowed;
    if (!(await check(ctx, actor, coreArgs)).ok) {
      return refuseAutomation(reminderScheduledAt <= result.now ? "time_past" : "deal_not_open");
    }
    const core = closer ? createCallbackTask : adminCreateManualReminderCore;
    const { followUpId } = await core(ctx, actor, coreArgs, WEB, {
      decisionId,
      task: {
        purpose: task.purpose, expectedAmountMinor: task.expectedAmountMinor,
        expectedCurrency: task.expectedCurrency, promisedPaymentAt: task.promisedPaymentAt,
        declineCode: task.declineCode,
      },
    });
    await finishCallConfirm(ctx, actor, result, followUpId);
    return { ok: true as const, alreadyApplied: false, decisionId, followUpId };
  },
});

export const declineCallDecision = mutation({
  args: { decisionId: v.id("resultAutomationDecisions") },
  returns: v.union(automationCommandRefusalValidator, v.object(callCommandSuccess)),
  handler: async (ctx, { decisionId }) => {
    const actor = await requireTenantUser(ctx, [...CALL_ASK_ROLES]);
    const loaded = await loadCallDecision(ctx, actor, decisionId);
    if (!loaded.ok) return loaded;
    const { decision } = loaded;
    if (decision.state === "stopped" && decision.stopCode === "person_stop") {
      return { ok: true as const, alreadyApplied: true };
    }
    if (decision.state !== "ready" && decision.state !== "needs_person") return refuseAutomation("not_ready");
    await stopDecision(ctx, decisionId, actor, "person_stop");
    return { ok: true as const, alreadyApplied: false };
  },
});

async function meetingForViewer(ctx: QueryCtx, actor: TenantUserResult, meetingId: Id<"meetings">) {
  const [viewer, meeting] = await Promise.all([insightsViewer(ctx, actor), ctx.db.get("meetings", meetingId)]);
  if (!viewer || !meeting || !(await canSeeMeeting(ctx, viewer, meeting))) return null;
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  return deal && { viewer, meeting, deal };
}

async function readCallQuotes(ctx: QueryCtx, viewer: InsightsViewer, meeting: Meeting, decision: Decision) {
  const unavailable = { quotes: [], quotesDeleted: false };
  if (!viewer.settings || (!viewer.isAdmin && viewer.settings.mode !== "on")) return unavailable;
  const evidence = callEvidenceOf(decision);
  if (!evidence) return unavailable;
  const [header, run, recording] = await Promise.all([
    headerFor(ctx, evidence.recordingId),
    ctx.db.get("callInsightRuns", evidence.runId),
    ctx.db.get("callRecordings", evidence.recordingId),
  ]);
  if (!header || !run || !recording || run.purpose !== "serve" || run.status !== "answered" ||
      run.tenantId !== viewer.tenant._id || run.meetingId !== meeting._id ||
      run.recordingId !== evidence.recordingId || run.generation !== evidence.generation ||
      !(await visibleHeader(ctx, viewer, meeting, header))) return unavailable;

  const now = Date.now();
  const masked = maskEvidenceQuotes(run, recording, now);
  if (header.quotesPurgedAt !== undefined || run.quotesPurgedAt !== undefined || transcriptGone(recording, now)) {
    return { quotes: [], quotesDeleted: true };
  }
  const statements = masked?.statements ?? [];
  const final = statements.find((line) => line.lineIndex === evidence.finalStatementLine && line.quote);
  const ordered = final ? [final, ...statements.filter((line) => line.lineIndex !== final.lineIndex)] : statements;
  return {
    quotes: ordered.flatMap(({ kind, quote, speaker, lineIndex, atSeconds }) =>
      quote ? [{ kind, quote, speaker, lineIndex, atSeconds }] : []).slice(0, 3),
    quotesDeleted: false,
  };
}

async function nameInTenant(ctx: QueryCtx, tenantId: Id<"tenants">, userId?: Id<"users">) {
  const user = userId ? await ctx.db.get("users", userId) : null;
  return user?.tenantId === tenantId ? user.fullName?.trim() || user.email : null;
}

export const getCallAsk = query({
  args: { meetingId: v.id("meetings") },
  returns: v.union(v.null(), v.object({
    decisionId: v.id("resultAutomationDecisions"),
    expectedInputKey: v.string(),
    kind: callKindValidator,
    state: askStateValidator,
    proposal: v.union(taskProposalValidator, refusalProposalValidator, v.null()),
    gates: v.array(automationGateValidator),
    quotes: quotesValidator,
    quotesDeleted: v.boolean(),
    notice: v.union(noticeValidator, v.null()),
    can: v.object({ confirm: v.boolean(), decline: v.boolean(), acknowledge: v.boolean(), stop: v.boolean() }),
  })),
  handler: async (ctx, { meetingId }) => {
    const actor = await requireTenantUser(ctx, [...CALL_ASK_ROLES]);
    const loaded = await meetingForViewer(ctx, actor, meetingId);
    if (!loaded) return null;
    const { viewer, meeting, deal } = loaded;
    if (meeting.status !== "scheduled" || deal.outcome !== "open") return null;
    const decisions = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_meetingId", (q) => q.eq("tenantId", deal.tenantId).eq("meetingId", meetingId))
      .order("desc").take(50);
    for (const decision of decisions) {
      const { state, kind } = decision;
      if ((state !== "ready" && state !== "notice" && state !== "needs_person") || decision.mode === "shadow" ||
          !isCallKind(kind) || decision.opportunityId !== deal._id ||
          decision.humanResultRevision !== (deal.humanResultRevision ?? 0) || decision.gates.includes("stood_down") ||
          !modeAtLeastAsk(effectiveKindMode(viewer.tenant, kind))) continue;

      const notice = state === "notice" ? {
        round: decision.noticeRound,
        hours: decision.noticeHours ?? viewer.tenant.resultAutomation?.refusalNoticeHours ?? 48,
        dueAt: decision.dueAt,
        acknowledgedAt: decision.acknowledgedAt,
        acknowledgedByUserId: decision.acknowledgedByUserId,
        acknowledgedByName: await nameInTenant(ctx, deal.tenantId, decision.acknowledgedByUserId),
        acknowledgedAs: decision.acknowledgedAs,
      } : null;
      const proposal = taskProposalOf(decision) ?? refusalProposalOf(decision) ?? null;
      const evidence = await readCallQuotes(ctx, viewer, meeting, decision);
      return {
        decisionId: decision._id, expectedInputKey: decision.inputKey, kind, state, proposal, gates: decision.gates,
        ...evidence,
        notice,
        can: {
          confirm: state !== "needs_person" && proposal !== null && !evidence.quotesDeleted && canRecordMeetingOutcome(deal),
          decline: state !== "notice",
          acknowledge: notice !== null && notice.acknowledgedAt === undefined,
          stop: notice !== null,
        },
      };
    }
    return null;
  },
});

/** The loss must still be the exact write accounted for by the refusal receipt. */
export function matchesAppliedRefusal(decision: Decision, deal: Deal): boolean {
  return decision.state === "applied" && decision.kind === "refusal_loss" &&
    (decision.appliedVia === "automatic"
      ? decision.resolvedByUserId === undefined
      : decision.appliedVia === "meeting_confirm" && decision.resolvedByUserId !== undefined) &&
    deal.outcome === "lost" && deal.lostReason === RESERVED_LOSS_REASONS.call_refusal &&
    decision.resolvedAt !== undefined && deal.lostAt === decision.resolvedAt &&
    deal.lostByUserId === decision.resolvedByUserId;
}

async function taskIsUntouched(ctx: QueryCtx, decision: Decision, deal: Deal, meeting: Meeting, task: Task) {
  const proposal = taskProposalOf(decision);
  if (!proposal || task.status !== "pending" || task.completedAt !== undefined ||
      task.reminderScheduledAt !== proposal.reminderScheduledAt || task.contactMethod !== proposal.contactMethod ||
      task.closerId !== deal.assignedCloserId || deal.stage !== "follow_up" || deal.outcome !== "open" ||
      decision.callBefore?.meetingId !== meeting._id) return false;
  const pending = await ctx.db.query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", deal._id).eq("status", "pending"))
    .take(21);
  return pending.length <= 20 && pending.every((other) =>
    other._id === task._id || other.reason === "stale_opportunity_nudge");
}

async function noLaterMeetingResult(ctx: QueryCtx, deal: Deal, meeting: Meeting, resolvedAt: number) {
  const meetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", deal._id)).take(51);
  return meetings.length <= 50 && meetings.every((other) =>
    other._id === meeting._id || other.status === "scheduled" ||
    (other.scheduledAt <= meeting.scheduledAt &&
      Math.max(other.heldMarkedAt ?? 0, other.noShowMarkedAt ?? 0, other.canceledAt ?? 0) <= resolvedAt));
}

export const getCallResultSummary = query({
  args: { meetingId: v.id("meetings") },
  returns: v.union(v.null(), v.object({
    decisionId: v.id("resultAutomationDecisions"),
    kind: callKindValidator,
    entry: v.union(v.literal("confirmed"), v.literal("automatic")),
    resolvedAt: v.number(),
    resolvedByUserId: v.optional(v.id("users")),
    resolvedByName: v.union(v.string(), v.null()),
    meetingHeld: v.literal(true),
    task: v.union(taskViewValidator, v.null()),
    lossReason: v.union(v.string(), v.null()),
    byline: v.union(v.string(), v.null()),
    quotes: quotesValidator,
    quotesDeleted: v.boolean(),
    can: v.object({
      changeNextStep: v.boolean(), withdrawAttendance: v.boolean(), undo: v.boolean(), reopen: v.boolean(),
    }),
  })),
  handler: async (ctx, { meetingId }) => {
    const actor = await requireTenantUser(ctx, [...CALL_ASK_ROLES]);
    const loaded = await meetingForViewer(ctx, actor, meetingId);
    if (!loaded) return null;
    const { viewer, meeting, deal } = loaded;
    if (meeting.status !== "held" || meeting.attendanceSource !== "call_insights" || !meeting.attendanceDecisionId) return null;
    const decision = await ctx.db.get("resultAutomationDecisions", meeting.attendanceDecisionId);
    if (!decision || decision.tenantId !== deal.tenantId || decision.opportunityId !== deal._id ||
        decision.meetingId !== meetingId || !isCallKind(decision.kind) ||
        (decision.state !== "applied" && !(decision.state === "corrected" && decision.kind !== "refusal_loss")) ||
        decision.resolvedAt === undefined ||
        (decision.appliedVia !== "meeting_confirm" && decision.appliedVia !== "automatic")) return null;

    const { kind, resolvedAt, resolvedByUserId } = decision;
    const resolvedByName = await nameInTenant(ctx, deal.tenantId, resolvedByUserId);
    const isRefusal = kind === "refusal_loss";
    // After "Change the next step" the receipt is corrected and names the
    // reminder the person set; the summary shows that one.
    const replacement = await correctedNextStepForWithdrawal(ctx, decision, deal);
    if (decision.state === "corrected" && !replacement) return null;
    const written = decision.writtenFollowUpId ? await ctx.db.get("followUps", decision.writtenFollowUpId) : null;
    const task = replacement ?? written;
    const taskView = task && task.tenantId === deal.tenantId && task.opportunityId === deal._id &&
      (replacement !== null || (task.automationDecisionId === decision._id && task.purpose === kind)) &&
      task.contactMethod && task.reminderScheduledAt !== undefined ? {
        followUpId: task._id, purpose: replacement ? replacement.purpose ?? "call_back" as const : kind as "call_back" | "payment_owed",
        contactMethod: task.contactMethod,
        reminderScheduledAt: task.reminderScheduledAt,
        expectedAmountMinor: task.expectedAmountMinor, expectedCurrency: task.expectedCurrency,
        promisedPaymentAt: task.promisedPaymentAt, declineCode: task.declineCode, status: task.status,
      } : null;
    const untouched = decision.state === "applied" &&
      decision.humanResultRevisionAfter === (deal.humanResultRevision ?? 0);
    const changeNextStep = !!(untouched && taskView && task && await taskIsUntouched(ctx, decision, deal, meeting, task));
    const reopen = untouched && isRefusal && !!deal.assignedCloserId && matchesAppliedRefusal(decision, deal) &&
      !(await loadDealOpenTasks(ctx, deal._id)).hasOpenTask;
    const automatic = decision.appliedVia === "automatic";
    return {
      decisionId: decision._id, kind, resolvedAt, resolvedByUserId, resolvedByName,
      entry: automatic ? "automatic" as const : "confirmed" as const,
      meetingHeld: true as const,
      task: taskView,
      lossReason: isRefusal ? lossReasonLabel(RESERVED_LOSS_REASONS.call_refusal) : null,
      byline: isRefusal ? refusalByline(RESERVED_LOSS_REASONS.call_refusal, {
        lostByUserId: resolvedByUserId, lostByName: resolvedByName,
      }) : null,
      ...await readCallQuotes(ctx, viewer, meeting, decision),
      can: {
        changeNextStep,
        withdrawAttendance: viewer.isAdmin && (changeNextStep || replacement !== null) &&
          await noLaterMeetingResult(ctx, deal, meeting, resolvedAt),
        undo: viewer.isAdmin && automatic && (reopen || changeNextStep),
        reopen,
      },
    };
  },
});
