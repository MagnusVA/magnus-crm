import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { noteHumanResult } from "../automation/humanResult";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { emitDomainEvent } from "../lib/domainEvents";
import { earliestCountingPayment, paymentCounts, readDealPayments, syncPersonEnrollments } from "../lib/enrollments";
import { correctLeadLifecycle } from "../lib/leadLifecycle";
import { patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { assertCoreRole, type CoreActor } from "../lib/outcomeCores";
import { expectedError } from "../lib/observability/errors";
import { addPinnedLine } from "../lib/pinnedLines";
import { isSideDeal } from "../lib/sideDeals";
import { refreshSoldProgramCachesForOpportunity } from "../lib/soldProgramCache";
import { sha256Hex, stableJson } from "../lib/stableHash";
import { isWonDeal } from "../opportunities/dealGuards";
import {
  RESERVED_LOSS_REASONS,
  type DealPosition,
  type DealTarget,
  type StageTransitionException,
} from "../opportunities/stages";
import { replacePaymentAggregate } from "../reporting/writeHooks";
import { clearActiveAllocation } from "./allocation";
import { clearAttendanceOwed, markAttendanceOwed } from "./attendanceDebt";
import {
  paymentCommandCodeValidator,
  paymentCommandRefusalValidator,
  refuse,
  type PaymentCommandCode,
  type PaymentCommandResult,
} from "./commandResult";
import { paymentStateFingerprint } from "./fingerprint";
import { exclusionCauseValidator } from "./schema";
import { settleExcludedPaymentTasks } from "../lib/taskSettlement";

// Taking a payment out (build contract §2.6, plan §2.10 and §12). One core
// excludes a payment row for every cause: a wrong match, a full refund, a
// lost chargeback, or the side-deal void. The payments that count afterwards
// decide what happens to the deal:
//
// - another payment still counts: the deal stays won and its first-payment
//   time moves to the earliest survivor;
// - none counts and the win was a Billing confirmation nobody has touched
//   since: one-tap Undo returns the deal to where the win found it;
// - none counts otherwise: the approval names the disposition, closed lost
//   (`payment_excluded`) or Follow-up with one reminder due now.
//
// A won deal with no counting payment is never committed, attendance a
// person recorded is never changed, and the excluded row keeps its
// provenance as a disputed row. Every refusal is returned before any write.

export type ExclusionCause = Infer<typeof exclusionCauseValidator>;
export type ExclusionLevel = "undo" | "reviewed";
export type ExclusionDisposition = "lost" | "follow_up";
export type ExclusionPolicy = "billing" | "side_deal";
export type UndoResult = "undo_booked" | "undo_follow_up" | "undo_system_loss" | "system_loss_on_undo";
export type ExclusionResult = "kept_won" | UndoResult | "lost" | "follow_up";

export type ExcludeArgs = {
  paymentRecordId: Id<"paymentRecords">;
  cause: ExclusionCause;
  level: ExclusionLevel;
  disposition?: ExclusionDisposition;
  /** Required with the Follow-up disposition when a new reminder is written. */
  followUpContactMethod?: "call" | "text";
  /** The preview's fingerprint. Billing passes it; the side-deal void has no preview. */
  expectedFingerprint?: string;
  /** The side-deal void's typed reason. It stays on the `payment.voided` event only. */
  voidReason?: string;
};

type Ctx = QueryCtx | MutationCtx;
type Payment = Doc<"paymentRecords">;
type Task = Doc<"followUps">;
type Decision = Doc<"resultAutomationDecisions">;

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;
const MEETING_LIMIT = 50;
const PENDING_TASK_LIMIT = 20;
const COMPLETED_TASK_LIMIT = 50;
const APPLIED_RECEIPT_LIMIT = 20;
const CORRECTION_LIST_LIMIT = 20;

export const exclusionDispositionValidator = v.union(v.literal("lost"), v.literal("follow_up"));
export const exclusionLevelValidator = v.union(v.literal("undo"), v.literal("reviewed"));
export const followUpContactMethodValidator = v.union(v.literal("call"), v.literal("text"));
const undoResultValidator = v.union(
  v.literal("undo_booked"),
  v.literal("undo_follow_up"),
  v.literal("undo_system_loss"),
  v.literal("system_loss_on_undo"),
);

export const exclusionPreviewValidator = v.object({
  fingerprint: v.string(),
  /** Counting payments left on the deal. */
  survivors: v.array(v.id("paymentRecords")),
  /** The deal's first-payment time after the exclusion, when it stays won. */
  newFirstPaymentAt: v.optional(v.number()),
  undo: v.object({ allowed: v.boolean(), result: v.optional(undoResultValidator) }),
  dispositionRequired: v.boolean(),
  allowedDispositions: v.array(exclusionDispositionValidator),
  cashDeltaByCurrency: v.array(v.object({ currency: v.string(), amountMinor: v.number() })),
  refusal: v.optional(v.union(paymentCommandCodeValidator, v.literal("deal_not_won"))),
});
export type ExclusionPreview = Infer<typeof exclusionPreviewValidator>;

export const exclusionCommandResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    alreadyApplied: v.boolean(),
    correctionId: v.id("paymentCorrections"),
  }),
  paymentCommandRefusalValidator,
);

// ─── Reads ──────────────────────────────────────────────────────────────

type ExclusionState = {
  row: Payment;
  deal: Doc<"opportunities">;
  payment: Doc<"providerPayments"> | null;
  dealPayments: Payment[];
  decision: Decision | null;
  /** Tasks this row completed (`completionPaymentId`). */
  completedTasks: Task[];
  /** Tasks the apply receipt says the win changed, as they are now. */
  receiptTasks: Array<{ task: Task; statusBefore: Task["status"] }>;
  meetings: Doc<"meetings">[];
  /** The deal's pending next steps, stale nudges left out. */
  pendingTasks: Task[];
};

/**
 * The apply receipt for this row: the decision that recorded it. Rows a
 * confirmation wrote name it; a receipt inserted for a person's pick is found
 * by the provider payment's applied decisions.
 */
export async function findApplyReceipt(ctx: Ctx, row: Payment): Promise<Decision | null> {
  if (row.automationDecisionId) {
    const decision = await ctx.db.get("resultAutomationDecisions", row.automationDecisionId);
    if (decision?.tenantId === row.tenantId && decision.appliedPaymentRecordId === row._id) return decision;
  }
  if (!row.providerPaymentId) return null;
  const providerPaymentId = row.providerPaymentId;
  const applied = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_providerPaymentId_and_state", (q) =>
      q.eq("tenantId", row.tenantId).eq("providerPaymentId", providerPaymentId).eq("state", "applied"))
    .take(APPLIED_RECEIPT_LIMIT + 1);
  if (applied.length > APPLIED_RECEIPT_LIMIT) {
    throw new Error(`Provider payment ${providerPaymentId} has more than ${APPLIED_RECEIPT_LIMIT} applied receipts`);
  }
  return applied.find((decision) => decision.appliedPaymentRecordId === row._id) ?? null;
}

async function tasksCompletedBy(ctx: Ctx, row: Payment, opportunityId: Id<"opportunities">) {
  const completed = await ctx.db.query("followUps")
    .withIndex("by_tenantId_and_completionPaymentId_and_opportunityId_and_status", (q) =>
      q.eq("tenantId", row.tenantId).eq("completionPaymentId", row._id)
        .eq("opportunityId", opportunityId).eq("status", "completed"))
    .take(COMPLETED_TASK_LIMIT + 1);
  if (completed.length > COMPLETED_TASK_LIMIT) {
    throw new Error(`Payment ${row._id} completed more than ${COMPLETED_TASK_LIMIT} tasks`);
  }
  return completed;
}

export async function readPendingTasks(ctx: Ctx, tenantId: Id<"tenants">, opportunityId: Id<"opportunities">) {
  const pending = await ctx.db.query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", opportunityId).eq("status", "pending"))
    .take(PENDING_TASK_LIMIT + 1);
  if (pending.length > PENDING_TASK_LIMIT) {
    throw new Error(`Deal ${opportunityId} has more than ${PENDING_TASK_LIMIT} pending tasks`);
  }
  return pending.filter((task) => task.tenantId === tenantId && task.reason !== "stale_opportunity_nudge");
}

export async function readDealMeetings(ctx: Ctx, tenantId: Id<"tenants">, opportunityId: Id<"opportunities">) {
  const meetings = await ctx.db.query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(MEETING_LIMIT + 1);
  if (meetings.length > MEETING_LIMIT) throw new Error(`Deal ${opportunityId} has more than ${MEETING_LIMIT} meetings`);
  return meetings.filter((meeting) => meeting.tenantId === tenantId);
}

async function loadExclusionState(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  paymentRecordId: Id<"paymentRecords">,
): Promise<ExclusionState> {
  const row = await ctx.db.get("paymentRecords", paymentRecordId);
  if (!row || row.tenantId !== tenantId) throw expectedError("payment.not_found", "Payment not found.");
  if (!row.opportunityId) throw expectedError("payment.no_deal", "Only a payment on a deal can be taken out.");
  const deal = await ctx.db.get("opportunities", row.opportunityId);
  if (!deal || deal.tenantId !== tenantId) throw expectedError("payment.not_found", "Payment not found.");
  const payment = row.providerPaymentId ? await ctx.db.get("providerPayments", row.providerPaymentId) : null;
  if (payment && payment.tenantId !== tenantId) {
    throw new Error(`Payment ${row._id} cites provider payment ${payment._id} in another tenant`);
  }
  const dealPayments = (await readDealPayments(ctx, deal._id)).filter((other) => other.tenantId === tenantId);
  const decision = await findApplyReceipt(ctx, row);
  const receiptTasks: ExclusionState["receiptTasks"] = [];
  for (const entry of decision?.before?.tasks ?? []) {
    const task = await ctx.db.get("followUps", entry.followUpId);
    if (task?.tenantId === tenantId && task.opportunityId === deal._id) {
      receiptTasks.push({ task, statusBefore: entry.status });
    }
  }
  return {
    row,
    deal,
    payment,
    dealPayments,
    decision,
    completedTasks: await tasksCompletedBy(ctx, row, deal._id),
    receiptTasks,
    meetings: await readDealMeetings(ctx, tenantId, deal._id),
    pendingTasks: await readPendingTasks(ctx, tenantId, deal._id),
  };
}

async function exclusionFingerprint(ctx: Ctx, state: ExclusionState, cause: ExclusionCause) {
  const receiptTaskIds = [
    ...state.receiptTasks.map(({ task }) => task._id),
    ...state.completedTasks.map((task) => task._id),
  ];
  return await paymentStateFingerprint(ctx, {
    tenantId: state.row.tenantId,
    opportunityId: state.deal._id,
    paymentRecordId: state.row._id,
    providerPaymentId: state.payment?._id,
    receiptTaskIds,
    extra: ["exclude", cause],
  });
}

async function exclusionRequestKey(args: ExcludeArgs, fingerprint: string) {
  // The contract's tuple, plus the level, so an undo and a reviewed
  // correction submitted on the same preview are never the same request.
  return await sha256Hex(stableJson([
    "exclude", args.paymentRecordId, fingerprint, args.level, args.disposition ?? null,
  ]));
}

export async function findExclusionReplay(ctx: Ctx, tenantId: Id<"tenants">, paymentRecordId: Id<"paymentRecords">, requestKey: string) {
  const receipt = await ctx.db.query("paymentCorrections")
    .withIndex("by_tenantId_and_requestKey", (q) => q.eq("tenantId", tenantId).eq("requestKey", requestKey))
    .first();
  if (receipt && (receipt.operation !== "exclude" || receipt.paymentRecordId !== paymentRecordId)) {
    throw new Error(`Correction ${receipt._id} has this request key for another subject`);
  }
  return receipt;
}

// ─── Rules ──────────────────────────────────────────────────────────────

/** The deal's current booking: the latest meeting the deal names, else the latest scheduled. */
export function currentMeetingOf(deal: Doc<"opportunities">, meetings: Doc<"meetings">[]) {
  const named = deal.latestMeetingId && meetings.find((meeting) => meeting._id === deal.latestMeetingId);
  if (named) return named;
  return meetings.reduce<Doc<"meetings"> | undefined>((latest, meeting) =>
    !latest || meeting.scheduledAt > latest.scheduledAt ||
      (meeting.scheduledAt === latest.scheduledAt && meeting._creationTime > latest._creationTime)
      ? meeting
      : latest, undefined);
}

type UndoPlan = {
  result: UndoResult;
  target: DealTarget;
  exception: StageTransitionException;
  loss?: { lostReason: string; lostAt: number };
  latestActivityAt: number;
  restoreTasks: Task[];
};

/** Whether the task is still as the win left it. */
function untouchedByWin(task: Task, row: Payment) {
  if (task.status === "expired") return !(task.type === "scheduling_link" && task.bookedAt !== undefined);
  return task.status === "completed" && task.completionPaymentId === row._id;
}

/** The receipts one-tap undo may reverse: a Billing confirmation, or an automatic write. */
function undoableReceipt(decision: Decision): boolean {
  return decision.appliedVia === "billing" ||
    (decision.appliedVia === "automatic" && decision.mode === "automatic" && decision.resolvedByUserId === undefined);
}

/**
 * One-tap undo: only for a Billing confirmation or an automatic write, with
 * stored before-fields, that no human result has followed (Calendly changes
 * don't bump the revision). Null when the reviewed correction is needed.
 */
function planUndo(state: ExclusionState, now: number): UndoPlan | null {
  const { decision, deal, row } = state;
  if (!decision || decision.state !== "applied" || !undoableReceipt(decision) || !decision.before) return null;
  if (decision.humanResultRevisionAfter === undefined ||
      (deal.humanResultRevision ?? 0) !== decision.humanResultRevisionAfter) return null;
  const before = decision.before;
  const latestActivityAt = before.latestActivityAt;

  if (before.position === "system_loss") {
    if (!before.systemLossReason) return null;
    return {
      result: "undo_system_loss",
      target: { stage: "closed", outcome: "lost" },
      exception: "payment_voided",
      loss: { lostReason: before.systemLossReason, lostAt: before.lostAt ?? now },
      latestActivityAt,
      restoreTasks: [],
    };
  }
  if (before.position !== "booked" && before.position !== "follow_up") return null;

  if (before.position === "booked") {
    const current = currentMeetingOf(deal, state.meetings);
    if (current?.status === "canceled" || current?.status === "no_show") {
      // Calendly closed the booking while the deal was won: the deal lands as
      // that missed-meeting loss, never Booked with a dead meeting.
      const lostAt = (current.status === "canceled" ? current.canceledAt : current.noShowMarkedAt) ?? now;
      return {
        result: "system_loss_on_undo",
        target: { stage: "closed", outcome: "lost" },
        exception: "payment_voided",
        loss: { lostReason: current.status === "canceled" ? "canceled" : "no_show", lostAt },
        latestActivityAt: Math.max(latestActivityAt, lostAt),
        restoreTasks: [],
      };
    }
    // Attendance recorded since the win is a person's result: review it.
    if (current && current.status !== "scheduled") return null;
  }

  const restoreTasks = state.receiptTasks
    .filter(({ task, statusBefore }) => statusBefore === "pending" && untouchedByWin(task, row))
    .map(({ task }) => task);
  const pendingAfter = state.pendingTasks.length + restoreTasks.length;
  if (before.position === "follow_up") {
    // A deal reopened at Follow-up has exactly one next step.
    if (pendingAfter !== 1) return null;
    return {
      result: "undo_follow_up",
      target: { stage: "follow_up" },
      exception: "provider_win_undone_to_follow_up",
      latestActivityAt,
      restoreTasks,
    };
  }
  if (pendingAfter > 1) return null;
  return {
    result: "undo_booked",
    target: { stage: "booked" },
    exception: "provider_win_undone_to_booked",
    latestActivityAt,
    restoreTasks,
  };
}

type FollowUpTaskPlan =
  | { kind: "keep"; task: Task }
  | { kind: "reopen"; task: Task }
  | { kind: "create"; closerId: Id<"users">; contactMethod: "call" | "text" };

type ExclusionPlan = {
  result: ExclusionResult;
  survivors: Payment[];
  newFirst?: Payment;
  undo?: UndoPlan;
  followUp?: FollowUpTaskPlan;
};

function isReminderFor(task: Task, closerId: Id<"users">) {
  return task.type === "manual_reminder" && task.closerId === closerId;
}

/** The one next step a reviewed Follow-up leaves, or a refusal. */
function planFollowUpTask(
  state: ExclusionState,
  args: Pick<ExcludeArgs, "followUpContactMethod">,
): FollowUpTaskPlan | PaymentCommandCode {
  const closerId = state.deal.assignedCloserId;
  if (!closerId) return "no_closer";
  if (state.pendingTasks.length > 0) {
    // A next step already waits: keep it only if it is the closer's reminder.
    const [task] = state.pendingTasks;
    return state.pendingTasks.length === 1 && isReminderFor(task, closerId) ? { kind: "keep", task } : "task_closer_conflict";
  }
  // Reuse the task the win closed, if nobody has worked it since.
  const original = [
    ...state.completedTasks,
    ...state.receiptTasks.filter(({ statusBefore }) => statusBefore === "pending").map(({ task }) => task),
  ].find((task) => isReminderFor(task, closerId) && untouchedByWin(task, state.row));
  if (original) return { kind: "reopen", task: original };
  if (!args.followUpContactMethod) {
    throw expectedError("payment.contact_method_required", "Choose call or text for the reminder.");
  }
  return { kind: "create", closerId, contactMethod: args.followUpContactMethod };
}

function survivorsOf(state: ExclusionState) {
  return state.dealPayments.filter((other) => other._id !== state.row._id && paymentCounts(other));
}

function isSideDealExclusion(state: ExclusionState, policy: ExclusionPolicy) {
  return policy === "side_deal" || isSideDeal(state.deal);
}

/** The checks every exclusion makes before writing, on the state just read. */
function assertExcludable(state: ExclusionState) {
  const { row, deal, payment } = state;
  if (!isWonDeal(deal)) {
    throw expectedError("payment.deal_not_won", "A payment can only be taken out of a won deal.");
  }
  if (payment && payment.paymentRecordId !== row._id) {
    throw new Error(`Payment ${row._id} counts and cites provider payment ${payment._id}, which counts through ${payment.paymentRecordId ?? "nothing"}`);
  }
}

function planExclusion(
  state: ExclusionState,
  args: ExcludeArgs,
  policy: ExclusionPolicy,
  now: number,
): ExclusionPlan | PaymentCommandCode {
  const survivors = survivorsOf(state);
  const sideDeal = isSideDealExclusion(state, policy);
  if (sideDeal && args.level === "undo") return "needs_review";
  if (survivors.length > 0) {
    if (args.disposition !== undefined) return "disposition_not_allowed";
    return { result: "kept_won", survivors, newFirst: earliestCountingPayment(survivors) };
  }
  if (args.level === "undo") {
    const undo = planUndo(state, now);
    return undo ? { result: undo.result, survivors, undo } : "needs_review";
  }
  // The side-deal void closes the deal lost, as it always has.
  const disposition = args.disposition ?? (policy === "side_deal" ? "lost" : undefined);
  if (!disposition) return "disposition_required";
  if (disposition === "lost") return { result: "lost", survivors };
  if (sideDeal) return "disposition_not_allowed";
  const followUp = planFollowUpTask(state, args);
  if (typeof followUp === "string") return followUp;
  return { result: "follow_up", survivors, followUp };
}

function positionAfter(result: ExclusionResult): DealPosition {
  switch (result) {
    case "kept_won":
      return "won";
    case "undo_booked":
      return "booked";
    case "undo_follow_up":
    case "follow_up":
      return "follow_up";
    case "undo_system_loss":
    case "system_loss_on_undo":
    case "lost":
      return "lost";
  }
}

// ─── Preview ────────────────────────────────────────────────────────────

/** What excluding the row would do now, and the fingerprint the approval pins. */
export async function previewExclusionCore(
  ctx: Ctx,
  actor: CoreActor,
  args: { paymentRecordId: Id<"paymentRecords">; cause: ExclusionCause },
  policy: ExclusionPolicy = "billing",
): Promise<ExclusionPreview> {
  assertCoreRole(actor, ADMIN_ROLES);
  const now = Date.now();
  const state = await loadExclusionState(ctx, actor.tenantId, args.paymentRecordId);
  const fingerprint = await exclusionFingerprint(ctx, state, args.cause);
  const counts = paymentCounts(state.row);
  if (counts && !isWonDeal(state.deal)) {
    return {
      fingerprint,
      survivors: [],
      undo: { allowed: false },
      dispositionRequired: false,
      allowedDispositions: [],
      cashDeltaByCurrency: [],
      refusal: "deal_not_won",
    };
  }
  const survivors = survivorsOf(state);
  if (counts) assertExcludable(state);
  const sideDeal = isSideDealExclusion(state, policy);
  const undo = counts && survivors.length === 0 && !sideDeal ? planUndo(state, now) : null;
  const newFirst = earliestCountingPayment(survivors);
  const allowedDispositions: ExclusionDisposition[] = survivors.length > 0
    ? []
    : sideDeal || !state.deal.assignedCloserId ? ["lost"] : ["lost", "follow_up"];
  return {
    fingerprint,
    survivors: survivors.map((other) => other._id),
    newFirstPaymentAt: newFirst?.recordedAt,
    undo: { allowed: undo !== null, result: undo?.result },
    dispositionRequired: survivors.length === 0,
    allowedDispositions,
    cashDeltaByCurrency: counts ? [{ currency: state.row.currency, amountMinor: -state.row.amountMinor }] : [],
    refusal: counts ? undefined : "stale_preview",
  };
}

// ─── The core ───────────────────────────────────────────────────────────

/**
 * Takes one payment out, in one mutation (contract §2.6). Re-reads every
 * fact the preview showed and compares the fingerprint; a replay of an
 * applied request returns `alreadyApplied` and writes nothing. Refusals are
 * returned before any write.
 */
export async function excludePaymentCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: ExcludeArgs,
  request: "billing" | { sideDealRequestKey: string },
): Promise<PaymentCommandResult<{ correctionId: Id<"paymentCorrections"> }>> {
  assertCoreRole(actor, ADMIN_ROLES);
  const now = Date.now();
  const { tenantId } = actor;
  let requestKey: string;
  if (request === "billing") {
    if (args.expectedFingerprint === undefined) {
      throw expectedError("payment.preview_required", "Preview the change first.");
    }
    requestKey = await exclusionRequestKey(args, args.expectedFingerprint);
    const replay = await findExclusionReplay(ctx, tenantId, args.paymentRecordId, requestKey);
    if (replay) return { ok: true, alreadyApplied: true, correctionId: replay._id };
  } else {
    requestKey = request.sideDealRequestKey;
  }
  const state = await loadExclusionState(ctx, tenantId, args.paymentRecordId);
  if (request === "billing" && args.expectedFingerprint !== await exclusionFingerprint(ctx, state, args.cause)) {
    return refuse("stale_preview");
  }
  if (!paymentCounts(state.row)) return refuse("stale_preview");
  assertExcludable(state);

  const policy = request === "billing" ? "billing" : "side_deal";
  const plan = planExclusion(state, args, policy, now);
  if (typeof plan === "string") return refuse(plan);

  const { row, deal, payment, decision } = state;
  const { result } = plan;
  const leavesWon = result !== "kept_won";
  const dealPositionAfter = positionAfter(result);
  const lostAtAfter = result === "lost" ? now : plan.undo?.loss?.lostAt;
  const revisionAfter = (deal.humanResultRevision ?? 0) + 1;

  // The receipt first, so every event below can name it.
  const correctionId = await ctx.db.insert("paymentCorrections", {
    tenantId,
    operation: "exclude",
    requestKey,
    level: args.level,
    cause: args.cause,
    result,
    paymentRecordId: row._id,
    providerPaymentId: payment?._id,
    opportunityId: deal._id,
    leadId: deal.leadId,
    decisionId: decision?._id,
    before: {
      paymentStatus: row.status,
      providerReviewState: payment?.reviewState,
      allocationRevision: payment?.allocationRevision,
      dealPosition: "won",
      paymentReceivedAt: deal.paymentReceivedAt,
      lostAt: deal.lostAt,
    },
    after: {
      dealPosition: dealPositionAfter,
      paymentReceivedAt: plan.newFirst?.recordedAt,
      lostAt: lostAtAfter,
      allocationRevision: payment ? payment.allocationRevision + 1 : undefined,
      humanResultRevision: revisionAfter,
    },
    tasks: [],
    removedEnrollments: [],
    vetoedOpportunityId: args.cause === "wrong_match" && payment ? deal._id : undefined,
    actorUserId: actor.userId,
    createdAt: now,
  });

  // The row stops counting and keeps its provenance and verification facts.
  await ctx.db.patch("paymentRecords", row._id, { status: "disputed", statusChangedAt: now });
  await replacePaymentAggregate(ctx, row, row._id);
  if (payment) {
    await clearActiveAllocation(ctx, row, args.cause === "wrong_match" ? { vetoOpportunityId: deal._id } : {});
    if (args.cause === "wrong_match" && payment.notMySaleAt !== undefined) {
      // A wrong match answers the closer's "This isn't my sale".
      await ctx.db.patch("providerPayments", payment._id, { notMySaleAt: undefined, notMySaleByUserId: undefined });
    }
  }
  await refreshSoldProgramCachesForOpportunity(ctx, { tenantId, opportunityId: deal._id });

  // The deal.
  const exception: StageTransitionException | undefined = plan.undo?.exception ??
    (result === "lost" ? "payment_voided" : result === "follow_up" ? "provider_win_corrected_to_follow_up" : undefined);
  const metadata = { exception, correctionId, decisionId: decision?._id, cause: args.cause, paymentId: row._id };
  if (result === "kept_won") {
    const first = plan.newFirst!;
    if (deal.paymentReceivedAt !== first.recordedAt) {
      await patchOpportunityLifecycle(ctx, deal._id, { paymentReceivedAt: first.recordedAt, updatedAt: now });
    }
  } else if (plan.undo) {
    const { undo } = plan;
    await transitionOpportunity(ctx, deal._id, {
      to: undo.target,
      fields: {
        paymentReceivedAt: undefined,
        updatedAt: now,
        latestActivityAt: undo.latestActivityAt,
        ...(undo.loss ? { lostReason: undo.loss.lostReason, lostAt: undo.loss.lostAt, lostByUserId: undefined } : {}),
      },
      exception: undo.exception,
      source: "admin",
      actorUserId: actor.userId,
      occurredAt: now,
      metadata,
    });
  } else if (result === "lost") {
    await transitionOpportunity(ctx, deal._id, {
      to: { stage: "closed", outcome: "lost" },
      fields: {
        paymentReceivedAt: undefined,
        updatedAt: now,
        lostAt: now,
        lostReason: RESERVED_LOSS_REASONS.payment_excluded,
        lostByUserId: actor.userId,
      },
      exception: "payment_voided",
      source: "admin",
      actorUserId: actor.userId,
      occurredAt: now,
      metadata,
    });
  } else {
    await transitionOpportunity(ctx, deal._id, {
      to: { stage: "follow_up" },
      fields: { paymentReceivedAt: undefined, updatedAt: now },
      exception: "provider_win_corrected_to_follow_up",
      source: "admin",
      actorUserId: actor.userId,
      occurredAt: now,
      metadata,
    });
  }

  // Tasks (plan §12): decided from the payments that count afterwards.
  const tasks = await settleExcludedPaymentTasks(ctx, {
    opportunity: deal,
    completedTasks: state.completedTasks,
    survivors: plan.survivors,
    restoreTasks: plan.undo?.restoreTasks,
    followUp: plan.followUp,
    followUpContactMethod: args.followUpContactMethod,
    correctionId,
    actorUserId: actor.userId,
    now,
  });

  if (leavesWon) {
    await clearAttendanceOwed(ctx, deal._id);
  } else if (plan.newFirst?.origin === "provider") {
    // The deal's first payment is now a Whop payment: its scheduled calls owe attendance.
    await markAttendanceOwed(ctx, deal._id);
  }

  const sync = await syncPersonEnrollments(ctx, {
    tenantId,
    leadId: deal.leadId,
    now,
    source: "admin",
    actorUserId: actor.userId,
  });
  await correctLeadLifecycle(ctx, deal.leadId, "payment_voided", actor.userId);

  const paymentAfter = payment && await ctx.db.get("providerPayments", payment._id);
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "payment",
    entityId: row._id,
    eventType: "payment.voided",
    source: "admin",
    actorUserId: actor.userId,
    fromStatus: row.status,
    toStatus: "disputed",
    reason: policy === "side_deal" ? args.voidReason : undefined,
    occurredAt: now,
    metadata: {
      opportunityId: deal._id,
      cause: args.cause,
      level: args.level,
      result,
      correctionId,
      providerPaymentId: payment?._id,
      decisionId: decision?._id,
      ...(policy === "side_deal" ? { origin: row.origin, sideDeal: true } : {}),
    },
  });

  await ctx.db.patch("paymentCorrections", correctionId, {
    after: {
      dealPosition: dealPositionAfter,
      paymentReceivedAt: plan.newFirst?.recordedAt,
      lostAt: lostAtAfter,
      allocationRevision: paymentAfter?.allocationRevision,
      humanResultRevision: revisionAfter,
    },
    tasks: tasks.slice(0, CORRECTION_LIST_LIMIT),
    removedEnrollments: sync.removed.slice(0, CORRECTION_LIST_LIMIT).map(({ enrollment }) => ({
      programId: enrollment.programId,
      status: enrollment.status,
    })),
  });
  if (decision?.state === "applied") {
    // A sampled check stays open: a correction does not replace the check.
    await ctx.db.patch("resultAutomationDecisions", decision._id, {
      state: plan.undo ? "undone" : "corrected",
      correctionId,
    });
  }
  if (row.attributedCloserId) {
    await addPinnedLine(ctx, {
      tenantId,
      userId: row.attributedCloserId,
      kind: leavesWon ? "win_removed" : "payment_removed",
      opportunityId: deal._id,
      paymentRecordId: row._id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      dealPositionAfter,
      decisionId: decision?._id,
      correctionId,
      createdAt: now,
    });
  }
  const { revision } = await noteHumanResult(ctx, deal._id, actor);
  if (revision !== revisionAfter) {
    throw new Error(`Deal ${deal._id} moved to revision ${revision}, expected ${revisionAfter}`);
  }
  return { ok: true, alreadyApplied: false, correctionId };
}

// ─── Public functions ───────────────────────────────────────────────────

/** Billing corrections: `billing:correct`, with Billing Ops on. */
async function billingCorrectionActor(
  ctx: Ctx,
  session: Awaited<ReturnType<typeof requireBillingPermission>>,
): Promise<CoreActor> {
  await requireBillingOpsEnabled(ctx, session.tenantId);
  return { userId: session.userId, tenantId: session.tenantId, role: session.role };
}

export const previewExclusion = query({
  args: { paymentRecordId: v.id("paymentRecords"), cause: exclusionCauseValidator },
  returns: exclusionPreviewValidator,
  handler: async (ctx, args) => {
    const session = await requireBillingPermission(ctx, "billing:correct");
    const actor = await billingCorrectionActor(ctx, session);
    return await previewExclusionCore(ctx, actor, args);
  },
});

export const excludePayment = mutation({
  args: {
    paymentRecordId: v.id("paymentRecords"),
    cause: exclusionCauseValidator,
    level: exclusionLevelValidator,
    disposition: v.optional(exclusionDispositionValidator),
    followUpContactMethod: v.optional(followUpContactMethodValidator),
    expectedFingerprint: v.string(),
  },
  returns: exclusionCommandResultValidator,
  handler: async (ctx, args) => {
    const session = await requireBillingPermission(ctx, "billing:correct");
    const actor = await billingCorrectionActor(ctx, session);
    return await excludePaymentCore(ctx, actor, args, "billing");
  },
});

/** The exclusions recorded on a deal, oldest first, for restore's ownership check. */
export async function readDealCorrections(ctx: Ctx, tenantId: Id<"tenants">, opportunityId: Id<"opportunities">) {
  const limit = 100;
  const rows = await ctx.db.query("paymentCorrections")
    .withIndex("by_tenantId_and_opportunityId_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunityId))
    .take(limit + 1);
  if (rows.length > limit) throw new Error(`Deal ${opportunityId} has more than ${limit} payment corrections`);
  return rows;
}
