import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { noteHumanResult } from "../automation/humanResult";
import { requireBillingOpsEnabled, requireBillingPermission } from "../billing/guards";
import { emitDomainEvent } from "../lib/domainEvents";
import { earliestCountingPayment, paymentCounts, readDealPayments, syncPersonEnrollments } from "../lib/enrollments";
import { recordPayment } from "../lib/leadLifecycle";
import { patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { assertCoreRole, type CoreActor } from "../lib/outcomeCores";
import { expectedError } from "../lib/observability/errors";
import { addPinnedLine } from "../lib/pinnedLines";
import { refreshSoldProgramCachesForOpportunity } from "../lib/soldProgramCache";
import { sha256Hex, stableJson } from "../lib/stableHash";
import {
  RESERVED_LOSS_REASONS,
  dealPosition,
  systemLossReasonOf,
  type DealPosition,
  type StageTransitionException,
} from "../opportunities/stages";
import { replacePaymentAggregate } from "../reporting/writeHooks";
import { setActiveAllocation } from "./allocation";
import { markAttendanceOwed } from "./attendanceDebt";
import {
  paymentCommandCodeValidator,
  paymentCommandRefusalValidator,
  refuse,
  type PaymentCommandCode,
  type PaymentCommandResult,
} from "./commandResult";
import { readDealCorrections, readPendingTasks } from "./exclude";
import { paymentStateFingerprint } from "./fingerprint";
import { settleRestoredPaymentTasks } from "../lib/taskSettlement";

// Restoring an exclusion made in error (build contract §2.6, plan §2.10).
// The row goes back to the status it had, the Whop payment points at it
// again, and the deal re-wins through the move that covers where the
// exclusion left it. Nothing here moves attendance, re-enables a membership
// binding, or writes a second payment row. A restore that would overwrite
// later work, or a Whop payment that now counts elsewhere, is refused with
// nothing written.

type Ctx = QueryCtx | MutationCtx;
type Correction = Doc<"paymentCorrections">;
type Task = Doc<"followUps">;
type TaskChange = Correction["tasks"][number];

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;
const RESTORABLE_ADVERSE_STATES: ReadonlySet<Doc<"providerPayments">["adverseState"]> = new Set(["none", "dispute_won"]);

export type RestoreMove = "none" | "ordinary" | "payment_exclusion_restored" | "provider_payment_after_system_loss";
const restoreMoveValidator = v.union(
  v.literal("none"),
  v.literal("ordinary"),
  v.literal("payment_exclusion_restored"),
  v.literal("provider_payment_after_system_loss"),
);

export const restorePreviewValidator = v.object({
  fingerprint: v.string(),
  result: v.optional(v.union(v.literal("restored_kept_won"), v.literal("restored_won"))),
  move: v.optional(restoreMoveValidator),
  /** The deal's first-payment time after the restore. */
  newFirstPaymentAt: v.optional(v.number()),
  cashDeltaByCurrency: v.array(v.object({ currency: v.string(), amountMinor: v.number() })),
  refusal: v.optional(paymentCommandCodeValidator),
});
export type RestorePreview = Infer<typeof restorePreviewValidator>;

export const restoreCommandResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    alreadyApplied: v.boolean(),
    correctionId: v.id("paymentCorrections"),
  }),
  paymentCommandRefusalValidator,
);

type RestoreState = {
  correction: Correction;
  row: Doc<"paymentRecords">;
  deal: Doc<"opportunities">;
  payment: Doc<"providerPayments"> | null;
  dealPayments: Doc<"paymentRecords">[];
  corrections: Correction[];
  /** The tasks the exclusion wrote, as they are now. */
  correctionTasks: Array<{ change: TaskChange["change"]; task: Task }>;
  pendingTasks: Task[];
  /** Tasks the excluded win had expired, from its apply receipt. */
  winExpiredTaskIds: Set<Id<"followUps">>;
};

async function loadRestoreState(ctx: Ctx, tenantId: Id<"tenants">, correctionId: Id<"paymentCorrections">): Promise<RestoreState> {
  const correction = await ctx.db.get("paymentCorrections", correctionId);
  if (!correction || correction.tenantId !== tenantId) throw expectedError("payment.correction_not_found", "Correction not found.");
  if (correction.operation !== "exclude") {
    throw expectedError("payment.not_an_exclusion", "Only a payment that was taken out can be restored.");
  }
  const row = await ctx.db.get("paymentRecords", correction.paymentRecordId);
  if (!row || row.tenantId !== tenantId) throw new Error(`Correction ${correction._id} names a missing payment`);
  const deal = await ctx.db.get("opportunities", correction.opportunityId);
  if (!deal || deal.tenantId !== tenantId || row.opportunityId !== deal._id) {
    throw new Error(`Correction ${correction._id} names a deal its payment isn't on`);
  }
  const payment = correction.providerPaymentId ? await ctx.db.get("providerPayments", correction.providerPaymentId) : null;
  if (payment && payment.tenantId !== tenantId) throw new Error(`Correction ${correction._id} names another tenant's payment`);

  const correctionTasks: RestoreState["correctionTasks"] = [];
  for (const { followUpId, change } of correction.tasks) {
    const task = await ctx.db.get("followUps", followUpId);
    if (!task || task.tenantId !== tenantId) throw new Error(`Correction ${correction._id} names a missing task`);
    correctionTasks.push({ change, task });
  }
  const decision = correction.decisionId ? await ctx.db.get("resultAutomationDecisions", correction.decisionId) : null;
  return {
    correction,
    row,
    deal,
    payment,
    dealPayments: (await readDealPayments(ctx, deal._id)).filter((other) => other.tenantId === tenantId),
    corrections: await readDealCorrections(ctx, tenantId, deal._id),
    correctionTasks,
    pendingTasks: await readPendingTasks(ctx, tenantId, deal._id),
    winExpiredTaskIds: new Set((decision?.before?.tasks ?? []).map(({ followUpId }) => followUpId)),
  };
}

async function restoreFingerprint(ctx: Ctx, state: RestoreState) {
  return await paymentStateFingerprint(ctx, {
    tenantId: state.correction.tenantId,
    opportunityId: state.deal._id,
    paymentRecordId: state.row._id,
    providerPaymentId: state.payment?._id,
    receiptTaskIds: state.correction.tasks.map(({ followUpId }) => followUpId),
    extra: ["restore", state.correction._id],
  });
}

/** Whether the deal's loss is exactly the one the exclusion wrote. */
function lossMatches(deal: Doc<"opportunities">, after: Correction["after"], result: Correction["result"]) {
  if (deal.lostAt !== after.lostAt) return false;
  if (result === "lost") return deal.lostReason === RESERVED_LOSS_REASONS.payment_excluded;
  return systemLossReasonOf(deal) !== null;
}

/** Whether the deal still stands where this correction left it. */
function stateMatches(state: RestoreState, position: DealPosition) {
  const { correction, deal } = state;
  if (position !== correction.after.dealPosition) return false;
  return position !== "lost" || lossMatches(deal, correction.after, correction.result);
}

/** A later exclusion on the deal that left it where it is now. */
function laterOwner(state: RestoreState, position: DealPosition) {
  const { correction, deal } = state;
  return state.corrections.some((other) =>
    other.operation === "exclude" && other._id !== correction._id && other.createdAt >= correction.createdAt &&
    other.restoredByCorrectionId === undefined && other.after.dealPosition === position &&
    (position !== "lost" || (other.after.lostAt === deal.lostAt && lossMatches(deal, other.after, other.result))));
}

type RestorePlan = {
  result: "restored_kept_won" | "restored_won";
  move: RestoreMove;
  exception?: StageTransitionException;
  first: Doc<"paymentRecords">;
  closeTasks: Array<{ change: TaskChange["change"]; task: Task }>;
};

function planRestore(state: RestoreState): RestorePlan | PaymentCommandCode {
  const { correction, row, deal, payment } = state;

  // The Whop payment counts elsewhere, or was allocated and freed since.
  if (payment) {
    if (payment.paymentRecordId !== undefined && payment.paymentRecordId !== row._id) return "reallocated";
    if (payment.allocationRevision !== correction.after.allocationRevision) return "reallocated";
    if (payment.reviewState === "dismissed") return "reallocated";
    if (payment.adverseFencedAt !== undefined || payment.refundedMinor > 0 ||
        !RESTORABLE_ADVERSE_STATES.has(payment.adverseState)) return "adverse";
    if (payment.status !== "paid") return "not_paid";
  }
  if (paymentCounts(row) || row.providerPaymentId !== correction.providerPaymentId) return "stale_preview";

  const position = dealPosition(deal.stage, deal.outcome);
  if (!stateMatches(state, position)) {
    return laterOwner(state, position) ? "closed_by_other_exclusion" : "stale_preview";
  }
  if (correction.removedEnrollments.some(({ status }) => status !== "active")) return "enrollment_status_changed";

  const first = earliestCountingPayment([
    ...state.dealPayments.filter((other) => other._id !== row._id),
    { ...row, status: correction.before.paymentStatus },
  ]);
  if (!first) throw new Error(`Restoring payment ${row._id} leaves deal ${deal._id} with no counting payment`);

  if (position === "won") return { result: "restored_kept_won", move: "none", first, closeTasks: [] };

  // The deal re-wins: the exclusion's own next steps must be untouched, and
  // no other next step may have appeared since.
  const closeTasks = state.correctionTasks.filter(({ change }) => change === "created" || change === "reopened");
  if (closeTasks.some(({ task }) => task.status !== "pending")) return "stale_preview";
  const owned = new Set<string>(closeTasks.map(({ task }) => task._id));
  if (state.pendingTasks.some((task) => !owned.has(task._id))) return "stale_preview";

  if (position === "lost") {
    return correction.result === "lost"
      ? { result: "restored_won", move: "payment_exclusion_restored", exception: "payment_exclusion_restored", first, closeTasks }
      : {
          result: "restored_won",
          move: "provider_payment_after_system_loss",
          exception: "provider_payment_after_system_loss",
          first,
          closeTasks,
        };
  }
  if (position === "booked" || position === "follow_up") return { result: "restored_won", move: "ordinary", first, closeTasks };
  return "stale_preview";
}

async function restoreRequestKey(correctionId: Id<"paymentCorrections">, fingerprint: string) {
  return await sha256Hex(stableJson(["restore", correctionId, fingerprint]));
}

/** What restoring the exclusion would do now, and the fingerprint the approval pins. */
export async function previewRestoreCore(
  ctx: Ctx,
  actor: CoreActor,
  args: { correctionId: Id<"paymentCorrections"> },
): Promise<RestorePreview> {
  assertCoreRole(actor, ADMIN_ROLES);
  const state = await loadRestoreState(ctx, actor.tenantId, args.correctionId);
  const fingerprint = await restoreFingerprint(ctx, state);
  if (state.correction.restoredByCorrectionId !== undefined) {
    return { fingerprint, cashDeltaByCurrency: [], refusal: "stale_preview" };
  }
  const plan = planRestore(state);
  if (typeof plan === "string") return { fingerprint, cashDeltaByCurrency: [], refusal: plan };
  return {
    fingerprint,
    result: plan.result,
    move: plan.move,
    newFirstPaymentAt: plan.first.recordedAt,
    cashDeltaByCurrency: [{ currency: state.row.currency, amountMinor: state.row.amountMinor }],
  };
}

/**
 * Restores one exclusion in one mutation (contract §2.6). A replay of an
 * applied request, or a restore already made, returns `alreadyApplied` and
 * writes nothing; every refusal is returned before any write.
 */
export async function restorePaymentCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: { correctionId: Id<"paymentCorrections">; expectedFingerprint: string },
): Promise<PaymentCommandResult<{ correctionId: Id<"paymentCorrections"> }>> {
  assertCoreRole(actor, ADMIN_ROLES);
  const now = Date.now();
  const { tenantId } = actor;
  const state = await loadRestoreState(ctx, tenantId, args.correctionId);
  const requestKey = await restoreRequestKey(args.correctionId, args.expectedFingerprint);
  const replay = await ctx.db.query("paymentCorrections")
    .withIndex("by_tenantId_and_requestKey", (q) => q.eq("tenantId", tenantId).eq("requestKey", requestKey))
    .first();
  if (replay) {
    if (replay.operation !== "restore" || replay.restoresCorrectionId !== args.correctionId) {
      throw new Error(`Correction ${replay._id} has this request key for another subject`);
    }
    return { ok: true, alreadyApplied: true, correctionId: replay._id };
  }
  const { correction, row, deal, payment } = state;
  if (correction.restoredByCorrectionId !== undefined) {
    // Someone restored it already, from another preview.
    return { ok: true, alreadyApplied: true, correctionId: correction.restoredByCorrectionId };
  }
  const plan = planRestore(state);
  if (typeof plan === "string") return refuse(plan);
  if (await restoreFingerprint(ctx, state) !== args.expectedFingerprint) return refuse("stale_preview");

  const positionBefore = dealPosition(deal.stage, deal.outcome);
  const revisionAfter = (deal.humanResultRevision ?? 0) + 1;
  const restoredStatus = correction.before.paymentStatus;
  if (restoredStatus === "disputed") throw new Error(`Correction ${correction._id} excluded a disputed payment`);

  const restoreId = await ctx.db.insert("paymentCorrections", {
    tenantId,
    operation: "restore",
    requestKey,
    result: plan.result,
    paymentRecordId: row._id,
    providerPaymentId: payment?._id,
    opportunityId: deal._id,
    leadId: deal.leadId,
    decisionId: correction.decisionId,
    restoresCorrectionId: correction._id,
    before: {
      paymentStatus: row.status,
      providerReviewState: payment?.reviewState,
      allocationRevision: payment?.allocationRevision,
      dealPosition: positionBefore,
      paymentReceivedAt: deal.paymentReceivedAt,
      lostAt: deal.lostAt,
    },
    after: {
      dealPosition: "won",
      paymentReceivedAt: plan.first.recordedAt,
      allocationRevision: payment ? payment.allocationRevision + 1 : undefined,
      humanResultRevision: revisionAfter,
    },
    tasks: [],
    removedEnrollments: [],
    actorUserId: actor.userId,
    createdAt: now,
  });

  await ctx.db.patch("paymentRecords", row._id, { status: restoredStatus, statusChangedAt: now });
  await replacePaymentAggregate(ctx, row, row._id);
  if (payment) {
    const restored = await ctx.db.get("paymentRecords", row._id);
    await setActiveAllocation(ctx, {
      payment,
      record: restored!,
      expectedAllocationRevision: payment.allocationRevision,
      reviewState: correction.before.providerReviewState === "linked" ? "linked" : "recorded",
      matchMethod: "person",
      actorUserId: actor.userId,
      now,
    });
  }
  await recordPayment(ctx, row._id);
  await refreshSoldProgramCachesForOpportunity(ctx, { tenantId, opportunityId: deal._id });

  const metadata = {
    exception: plan.exception,
    correctionId: restoreId,
    restoresCorrectionId: correction._id,
    decisionId: correction.decisionId,
    cause: correction.cause,
    paymentId: row._id,
  };
  if (plan.move === "none") {
    if (deal.paymentReceivedAt !== plan.first.recordedAt) {
      await patchOpportunityLifecycle(ctx, deal._id, { paymentReceivedAt: plan.first.recordedAt, updatedAt: now });
    }
  } else {
    await transitionOpportunity(ctx, deal._id, {
      to: { stage: "closed", outcome: "won" },
      fields: { paymentReceivedAt: plan.first.recordedAt, updatedAt: now },
      exception: plan.exception,
      source: "admin",
      actorUserId: actor.userId,
      occurredAt: now,
      metadata,
    });
  }

  // The next steps the exclusion opened close again (plan §12).
  const tasks = await settleRestoredPaymentTasks(ctx, {
    payment: { ...row, status: restoredStatus },
    closeTasks: plan.closeTasks,
    winExpiredTaskIds: state.winExpiredTaskIds,
    restoreId,
    actorUserId: actor.userId,
    now,
  });

  if (plan.first.origin === "provider") {
    // The deal's first payment is a Whop payment again: scheduled calls owe attendance.
    await markAttendanceOwed(ctx, deal._id);
  }
  await syncPersonEnrollments(ctx, { tenantId, leadId: deal.leadId, now, source: "admin", actorUserId: actor.userId });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "payment",
    entityId: row._id,
    eventType: "payment.restored",
    source: "admin",
    actorUserId: actor.userId,
    fromStatus: "disputed",
    toStatus: restoredStatus,
    occurredAt: now,
    metadata: {
      opportunityId: deal._id,
      correctionId: restoreId,
      restoresCorrectionId: correction._id,
      providerPaymentId: payment?._id,
      fromStatus: "disputed",
      toStatus: restoredStatus,
    },
  });

  const paymentAfter = payment && await ctx.db.get("providerPayments", payment._id);
  await ctx.db.patch("paymentCorrections", restoreId, {
    after: {
      dealPosition: "won",
      paymentReceivedAt: plan.first.recordedAt,
      allocationRevision: paymentAfter?.allocationRevision,
      humanResultRevision: revisionAfter,
    },
    tasks,
  });
  await ctx.db.patch("paymentCorrections", correction._id, { restoredByCorrectionId: restoreId });
  if (row.attributedCloserId) {
    await addPinnedLine(ctx, {
      tenantId,
      userId: row.attributedCloserId,
      kind: "payment_restored",
      opportunityId: deal._id,
      paymentRecordId: row._id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      dealPositionAfter: "won",
      decisionId: correction.decisionId,
      correctionId: restoreId,
      createdAt: now,
    });
  }
  const { revision } = await noteHumanResult(ctx, deal._id, actor);
  if (revision !== revisionAfter) {
    throw new Error(`Deal ${deal._id} moved to revision ${revision}, expected ${revisionAfter}`);
  }
  return { ok: true, alreadyApplied: false, correctionId: restoreId };
}

/** Billing corrections: `billing:correct`, with Billing Ops on. */
async function billingCorrectionActor(
  ctx: Ctx,
  session: Awaited<ReturnType<typeof requireBillingPermission>>,
): Promise<CoreActor> {
  await requireBillingOpsEnabled(ctx, session.tenantId);
  return { userId: session.userId, tenantId: session.tenantId, role: session.role };
}

export const previewRestore = query({
  args: { correctionId: v.id("paymentCorrections") },
  returns: restorePreviewValidator,
  handler: async (ctx, args) => {
    const session = await requireBillingPermission(ctx, "billing:correct");
    const actor = await billingCorrectionActor(ctx, session);
    return await previewRestoreCore(ctx, actor, args);
  },
});

export const restorePayment = mutation({
  args: { correctionId: v.id("paymentCorrections"), expectedFingerprint: v.string() },
  returns: restoreCommandResultValidator,
  handler: async (ctx, args) => {
    const session = await requireBillingPermission(ctx, "billing:correct");
    const actor = await billingCorrectionActor(ctx, session);
    return await restorePaymentCore(ctx, actor, args);
  },
});
