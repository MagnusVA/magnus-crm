import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { supersedePaymentDecisions } from "../automation/decisions";
import { deriveDecision, paymentBillingReason, type PaymentDecisionInput } from "../automation/derive";
import { noteHumanResult } from "../automation/humanResult";
import { recordApplyReceipt } from "../automation/receipts";
import { effectiveKindMode } from "../automation/settings";
import { followMergeChain } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { earliestCountingPayment, paymentCounts, syncPersonEnrollments } from "../lib/enrollments";
import { computeLatestActivityAt, patchOpportunityLifecycle, transitionOpportunity } from "../lib/opportunityActivity";
import { paymentTypeValidator, resolveLegacyCompatibleAttributedCloserId, type PaymentType } from "../lib/paymentTypes";
import { insertRecordedPayment } from "../lib/paymentWrite";
import { addPinnedLine } from "../lib/pinnedLines";
import type { CrmRole } from "../lib/roleMapping";
import { isSideDeal } from "../lib/sideDeals";
import { setSoldProgramCaches } from "../lib/soldProgramCache";
import { stableJson } from "../lib/stableHash";
import { dealPosition, systemLossReasonOf } from "../opportunities/stages";
import { ALLOCATION_HISTORY_LIMIT, readActiveAllocation, setActiveAllocation } from "./allocation";
import { ATTENDANCE_DEBT_MEETING_LIMIT, markAttendanceOwed } from "./attendanceDebt";
import { DEALS_PER_PERSON_HOLD, PAYMENT_ROWS_PER_DEAL_HOLD } from "./capacity";
import { paymentCommandRefusalValidator, refuse } from "./commandResult";
import { FINGERPRINT_BINDING_LIMIT, FINGERPRINT_MEETING_LIMIT, FINGERPRINT_TASK_LIMIT, paymentStateFingerprint } from "./fingerprint";
import { findPaymentTarget, type PaymentTarget } from "./match";

type ReadCtx = QueryCtx | MutationCtx;
type Payment = Doc<"providerPayments">;
type Deal = Doc<"opportunities">;
type Decision = Doc<"resultAutomationDecisions">;
type Before = NonNullable<Decision["before"]>;

export type ApplyVia = "billing" | "meeting_no_show";

type PreviewArgs = {
  tenantId: Id<"tenants">;
  providerPaymentId: Id<"providerPayments">;
  opportunityId: Id<"opportunities">;
  now: number;
};
type ApplyArgs = PreviewArgs & {
  decisionId?: Id<"resultAutomationDecisions">;
  expectedFingerprint: string;
  expectedAllocationRevision: number;
  approver: { userId: Id<"users">; role: CrmRole; source: "admin" | "closer" };
  via: ApplyVia;
  meetingId?: Id<"meetings">;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
};

export const providerApplyPreviewValidator = v.union(
  paymentCommandRefusalValidator,
  v.object({
    ok: v.literal(true),
    alreadyApplied: v.boolean(),
    fingerprint: v.string(),
    allocationRevision: v.number(),
    position: v.union(v.literal("booked"), v.literal("follow_up"), v.literal("system_loss"), v.literal("won")),
    kind: v.union(v.literal("payment_win"), v.literal("additional_payment")),
    proposal: v.object({
      amountMinor: v.number(),
      currency: v.string(),
      paymentType: v.optional(paymentTypeValidator),
      programId: v.optional(v.id("tenantPrograms")),
      attributedCloserId: v.id("users"),
      expiresFollowUpIds: v.array(v.id("followUps")),
    }),
  }),
);

export const providerApplyResultValidator = v.union(
  paymentCommandRefusalValidator,
  v.object({
    ok: v.literal(true),
    alreadyApplied: v.boolean(),
    paymentRecordId: v.id("paymentRecords"),
    decisionId: v.id("resultAutomationDecisions"),
  }),
);

type Preview = typeof providerApplyPreviewValidator.type;
type ApplyResult = typeof providerApplyResultValidator.type;
type Binding = Doc<"paymentProviderBindings">;

async function readBinding(ctx: ReadCtx, payment: Payment, kind: Binding["kind"], externalId?: string) {
  if (!externalId) return null;
  const [latest, older] = await ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) =>
      q.eq("tenantId", payment.tenantId).eq("connectionId", payment.connectionId)
        .eq("kind", kind).eq("externalId", externalId))
    .order("desc").take(2);
  if ((latest && latest.binding.kind !== kind) || older?.enabled) return "ambiguous" as const;
  return latest ?? null;
}

async function readMembership(ctx: ReadCtx, row: Binding | null, payment: Payment, deal: Deal) {
  if (!row || row.binding.kind !== "membership_deal") return null;
  const { binding } = row;
  const [boundLead, anchor] = await Promise.all([
    ctx.db.get("leads", binding.leadId),
    ctx.db.get("paymentRecords", binding.anchorPaymentRecordId),
  ]);
  const origin = anchor?.providerPaymentId && await ctx.db.get("providerPayments", anchor.providerPaymentId);
  const survivor = boundLead?.tenantId === payment.tenantId ? await followMergeChain(ctx, boundLead) : null;
  if (!row.enabled || !anchor || anchor.tenantId !== payment.tenantId || !paymentCounts(anchor) ||
      anchor.opportunityId !== binding.opportunityId || !survivor || !origin ||
      origin.tenantId !== payment.tenantId || origin.connectionId !== payment.connectionId ||
      origin.membershipId !== payment.membershipId || origin.paymentRecordId !== anchor._id) return null;
  if (binding.opportunityId !== deal._id) return "another_deal" as const;
  if (survivor._id !== deal.leadId) return null;
  return { bindingId: row._id, version: row.version, anchorCounts: true, anchor };
}

async function prepareApply(ctx: ReadCtx, args: PreviewArgs) {
  const { tenantId, opportunityId, providerPaymentId, now } = args;
  const [payment, deal, tenant] = await Promise.all([
    ctx.db.get("providerPayments", providerPaymentId),
    ctx.db.get("opportunities", opportunityId),
    ctx.db.get("tenants", tenantId),
  ]);
  if (!tenant || deal?.tenantId !== tenantId || payment?.tenantId !== tenantId) return refuse("stale_preview");
  if (payment.paymentRecordId) return refuse("reallocated");
  const rawPosition = dealPosition(deal.stage, deal.outcome);
  const kind = rawPosition === "won" ? "additional_payment" : "payment_win";
  const settings = tenant.resultAutomation;
  if (tenant.status !== "active" || !settings || effectiveKindMode(tenant, kind) !== "ask") return refuse("kind_off");
  if (isSideDeal(deal) || rawPosition === "call_held") return refuse("side_deal");
  if (rawPosition === "qualified") return refuse("qualified_only");
  const systemLoss = systemLossReasonOf(deal);
  if (rawPosition === "lost" && !systemLoss) return refuse("lost_by_person");
  const position = rawPosition === "lost" ? "system_loss" : rawPosition;
  if (payment.status !== "paid" || payment.paidAt === undefined || payment.totalMinor === 0) return refuse("not_paid");
  if (payment.totalMinor === undefined || !Number.isSafeInteger(payment.totalMinor) ||
      payment.totalMinor < 0 || payment.decimals !== 2 || !/^[A-Z]{3}$/.test(payment.currency)) return refuse("amount_mismatch");
  if (payment.adverseState !== "none" || payment.adverseFencedAt !== undefined || payment.refundedMinor !== 0) {
    return refuse("adverse");
  }
  if (payment.reviewState !== "needs_person" || payment.notMySaleAt !== undefined ||
      payment.reviewReason === "covers_several" || payment.reviewReason === "amount_mismatch") return refuse("needs_review");

  const attributedCloserId = deal.assignedCloserId;
  if (!attributedCloserId) return refuse("no_closer");
  const [connection, lead, closer, payments, personDeals] = await Promise.all([
    ctx.db.get("tenantPaymentConnections", payment.connectionId),
    ctx.db.get("leads", deal.leadId),
    ctx.db.get("users", attributedCloserId),
    ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", opportunityId)).take(PAYMENT_ROWS_PER_DEAL_HOLD),
    ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", deal.leadId)).take(DEALS_PER_PERSON_HOLD),
  ]);
  if (connection?.tenantId !== tenantId || connection.status !== "connected") return refuse("binding_invalid");
  if (lead?.tenantId !== tenantId || lead.status === "merged") return refuse("stale_preview");
  if (closer?.tenantId !== tenantId) return refuse("no_closer");
  if (payments.length >= PAYMENT_ROWS_PER_DEAL_HOLD || personDeals.length >= DEALS_PER_PERSON_HOLD) {
    return refuse("capacity_hold");
  }

  const [provenance, tasks, meetings, dealBindings, productRow, variantRow, membershipRow, checkoutRow, matched] =
    await Promise.all([
      ctx.db.query("paymentRecords").withIndex("by_tenantId_and_providerPaymentId", (q) =>
        q.eq("tenantId", tenantId).eq("providerPaymentId", providerPaymentId)).take(ALLOCATION_HISTORY_LIMIT),
      ctx.db.query("followUps").withIndex("by_opportunityId_and_status_and_reason", (q) =>
        q.eq("opportunityId", opportunityId).eq("status", "pending")).take(FINGERPRINT_TASK_LIMIT + 1),
      ctx.db.query("meetings").withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunityId)).take(FINGERPRINT_MEETING_LIMIT + 1),
      ctx.db.query("paymentProviderBindings").withIndex("by_tenantId_and_opportunityId_and_kind", (q) =>
        q.eq("tenantId", tenantId).eq("opportunityId", opportunityId).eq("kind", "membership_deal"))
        .take(FINGERPRINT_BINDING_LIMIT + 1),
      readBinding(ctx, payment, "product_program", payment.productId),
      readBinding(ctx, payment, "variant_type", payment.variantId),
      readBinding(ctx, payment, "membership_deal", payment.membershipId),
      readBinding(ctx, payment, "checkout_deal", payment.checkoutConfigurationId),
      findPaymentTarget(ctx, payment, now),
    ]);
  if (provenance.some(paymentCounts)) return refuse("reallocated");
  if (tasks.length > FINGERPRINT_TASK_LIMIT || meetings.length > FINGERPRINT_MEETING_LIMIT ||
      dealBindings.length > FINGERPRINT_BINDING_LIMIT || provenance.length >= ALLOCATION_HISTORY_LIMIT ||
      tasks.some((task) => task.tenantId !== tenantId || task.leadId !== deal.leadId) ||
      meetings.some((meeting) => meeting.tenantId !== tenantId) ||
      payments.some((row) => row.tenantId !== tenantId)) return refuse("needs_review");
  const scheduled = meetings.filter((meeting) => meeting.status === "scheduled")
    .sort((left, right) => left.scheduledAt - right.scheduledAt || left._creationTime - right._creationTime);
  if (kind === "payment_win" && scheduled.length > ATTENDANCE_DEBT_MEETING_LIMIT) return refuse("needs_review");

  if (productRow === "ambiguous" || variantRow === "ambiguous" ||
      membershipRow === "ambiguous" || checkoutRow === "ambiguous") return refuse("binding_invalid");
  if (matched.kind === "ready" && (matched.opportunityId !== opportunityId || matched.leadId !== deal.leadId)) {
    return refuse("binding_invalid");
  }
  if (checkoutRow?.enabled && checkoutRow.binding.kind === "checkout_deal" &&
      checkoutRow.binding.opportunityId !== opportunityId) return refuse("binding_invalid");
  const membership = await readMembership(ctx, membershipRow, payment, deal);
  if (membership === "another_deal" || (membershipRow?.enabled && !membership)) return refuse("binding_invalid");

  const firstPayment = earliestCountingPayment(payments);
  const firstCredit = firstPayment && resolveLegacyCompatibleAttributedCloserId(firstPayment);
  if (firstCredit && firstCredit !== attributedCloserId) return refuse("credit_conflict");
  if (tasks.some((task) => task.closerId !== attributedCloserId)) return refuse("task_closer_conflict");
  const blockingManualPaymentIds = payments.flatMap((row) =>
    row._id !== membership?.anchor._id && paymentCounts(row) && !row.providerPaymentId ? [row._id] : []);
  if (blockingManualPaymentIds.length) return refuse("unlinked_manual_payment");
  if ((position === "won") !== Boolean(firstPayment)) throw new Error("Deal outcome and counting payments disagree");

  const product = productRow?.enabled && productRow.binding.kind === "product_program" ? productRow.binding : undefined;
  const variant = variantRow?.enabled && variantRow.binding.kind === "variant_type" ? variantRow.binding : undefined;
  const inheritedProgramId = position === "won" ? deal.soldProgramId ?? firstPayment?.programId : undefined;
  const mappedProgramId = paymentBillingReason(payment.billingReason) === "renewal" && membership
    ? inheritedProgramId ?? membership.anchor.programId : product?.programId;
  if (mappedProgramId && ((membership && mappedProgramId !== membership.anchor.programId) ||
      (inheritedProgramId && mappedProgramId !== inheritedProgramId))) return refuse("binding_invalid");
  const mappedProgram = mappedProgramId && await ctx.db.get("tenantPrograms", mappedProgramId);
  if (mappedProgramId && (!mappedProgram || mappedProgram.tenantId !== tenantId)) return refuse("program_required");
  const paymentType = kind === "additional_payment" ? variant?.laterPaymentType ?? variant?.paymentType : variant?.paymentType;
  const bindingRows = [productRow, variantRow, membershipRow, checkoutRow].flatMap((row) => row ? [row] : []);
  // A person can select a deal when the matcher abstains. A ready ask,
  // however, must still come from the rule and agree with its live proposal.
  const target: PaymentTarget = matched.kind === "ready" ? matched : {
    kind: "needs_person",
    reason: matched.kind === "needs_person" ? matched.reason : "binding_conflict",
    candidateLeadId: deal.leadId,
    candidateOpportunityIds: [opportunityId],
  };
  const derived = deriveDecision({
    now,
    settings: { mode: "ask", policyVersion: settings.kinds[kind].policyVersion, activationVersion: settings.activationVersion },
    payment: {
      ...payment, fenced: false, fenceRevision: payment.adverseFenceRevision,
      financing: (payment.financingInstallmentsCount ?? 0) > 1,
      excludedOpportunityIds: payment.excludedOpportunityIds ?? [],
    },
    autoImportAfter: connection.autoImportAfter, connectionEpoch: connection.connectedAt,
    target,
    deal: {
      _id: deal._id, position: rawPosition, isSideDeal: false, systemLoss, createdAt: deal.createdAt,
      assignedCloserId: attributedCloserId, humanResultRevision: deal.humanResultRevision ?? 0,
      storedPaymentCount: payments.length, personDealCount: personDeals.length, firstCountingCreditCloserId: firstCredit,
      blockingManualPaymentIds, currentMeeting: position === "booked" ? scheduled[0] : undefined,
      pendingTasks: tasks.map(({ _id, type, reason, closerId }) => ({ _id, type, reason, closerId })),
    },
    mapping: {
      programId: mappedProgram?._id,
      paymentType,
      bindingIds: bindingRows.map((row) => row._id),
      bindingVersions: bindingRows.map((row) => row.version),
    },
    membership,
    standDown: settings.pausedAt !== undefined && payment.paidAt <= settings.pausedAt,
  } satisfies PaymentDecisionInput);
  if (!derived || derived.kind !== kind) return refuse("stale_preview");

  const expires = kind === "payment_win" ? tasks : [];
  const fingerprint = await paymentStateFingerprint(ctx, {
    tenantId, providerPaymentId, opportunityId,
    extra: [
      "provider_apply", connection._id, connection.connectedAt, connection.autoImportAfter, settings.activationVersion,
      settings.kinds[kind].policyVersion, payment.totalMinor, payment.currency, payment.paidAt,
      payment.adverseFenceRevision ?? null, payment.reviewReason ?? null, mappedProgram?._id ?? null,
      paymentType ?? null, inheritedProgramId ?? null,
      stableJson(bindingRows.map((row) => [row._id, row.version, row.enabled])),
      stableJson(meetings.map((row) => [row._id, row.scheduledAt, row.durationMinutes])),
      stableJson(tasks.map((row) => [row._id, row.type, row.reason, row.closerId])),
      stableJson(payment.excludedOpportunityIds ?? []),
    ],
  });
  const preview = {
    ok: true, alreadyApplied: false, fingerprint, allocationRevision: payment.allocationRevision,
    position, kind,
    proposal: {
      amountMinor: payment.totalMinor, currency: payment.currency, paymentType,
      programId: mappedProgram?._id, attributedCloserId,
      expiresFollowUpIds: expires.map((task) => task._id),
    },
  } as const satisfies Preview;
  return { ...preview, deal, payment, derived, meetings, scheduled, expires, bindingRows, inheritedProgramId, membership, systemLoss };
}

export async function previewProviderApply(ctx: ReadCtx, args: PreviewArgs): Promise<Preview> {
  const prepared = await prepareApply(ctx, args);
  if (!prepared.ok) return prepared;
  const { fingerprint, allocationRevision, position, kind, proposal } = prepared;
  return { ok: true, alreadyApplied: false, fingerprint, allocationRevision, position, kind, proposal };
}

async function readRetry(ctx: MutationCtx, args: ApplyArgs, payment: Payment, decision: Decision | null): Promise<ApplyResult> {
  if (!args.decisionId && payment.allocationRevision !== args.expectedAllocationRevision + 1) return refuse("reallocated");
  const row = await readActiveAllocation(ctx, payment);
  if (row?.opportunityId !== args.opportunityId || row.origin !== "provider" ||
      row.meetingId !== args.meetingId) return refuse("reallocated");
  const receipt = decision ?? (!args.decisionId && row.automationDecisionId
    ? await ctx.db.get("resultAutomationDecisions", row.automationDecisionId) : null);
  if (receipt?.state !== "applied" || receipt.tenantId !== args.tenantId ||
      receipt.providerPaymentId !== payment._id || receipt.opportunityId !== args.opportunityId ||
      receipt.appliedVia !== args.via || receipt.appliedPaymentRecordId !== row._id) return refuse("reallocated");
  return { ok: true, alreadyApplied: true, paymentRecordId: row._id, decisionId: receipt._id };
}

export async function applyProviderPayment(ctx: MutationCtx, args: ApplyArgs): Promise<ApplyResult> {
  const { tenantId, providerPaymentId, opportunityId, approver, via, now, meetingId } = args;
  const [payment, decision] = await Promise.all([
    ctx.db.get("providerPayments", providerPaymentId),
    args.decisionId ? ctx.db.get("resultAutomationDecisions", args.decisionId) : null,
  ]);
  if (payment?.tenantId !== tenantId || (args.decisionId && (decision?.tenantId !== tenantId ||
      decision.providerPaymentId !== providerPaymentId || decision.opportunityId !== opportunityId))) {
    return refuse("stale_preview");
  }
  if (payment.paymentRecordId) return await readRetry(ctx, args, payment, decision);
  if (payment.allocationRevision !== args.expectedAllocationRevision) return refuse("stale_preview");
  const prepared = await prepareApply(ctx, args);
  if (!prepared.ok) return prepared;
  const { deal, derived, position, kind, proposal, expires, meetings, scheduled, bindingRows, inheritedProgramId, membership, systemLoss } = prepared;
  if (prepared.fingerprint !== args.expectedFingerprint) return refuse("stale_preview");

  if (decision) {
    const settings = (await ctx.db.get("tenants", tenantId))?.resultAutomation;
    if (decision.state !== "ready" || decision.mode !== "ask" || decision.kind !== kind || decision.leadId !== deal.leadId ||
        decision.humanResultRevision !== (deal.humanResultRevision ?? 0) ||
        decision.activationVersion !== settings?.activationVersion ||
        decision.policyVersion !== settings.kinds[kind].policyVersion ||
        decision.evidence.allocationRevision !== payment.allocationRevision ||
        decision.evidence.sourceUpdatedAt !== payment.sourceUpdatedAt ||
        stableJson(decision.evidence.bindingIds) !== stableJson(bindingRows.map((row) => row._id)) ||
        stableJson(decision.evidence.bindingVersions) !== stableJson(bindingRows.map((row) => row.version)) ||
        !derived.wouldWrite || decision.confirmRoute !== derived.confirmRoute || decision.meetingId !== derived.meetingId ||
        decision.proposal?.completesFollowUpId !== derived.proposal?.completesFollowUpId ||
        decision.assignedCloserId !== proposal.attributedCloserId ||
        decision.proposal?.amountMinor !== proposal.amountMinor || decision.proposal.currency !== proposal.currency ||
        decision.proposal.programId !== proposal.programId || decision.proposal.paymentType !== proposal.paymentType) {
      return refuse("stale_preview");
    }
  }
  if (via === "meeting_no_show") {
    if (!meetingId || position !== "booked" || !derived.wouldWrite || derived.meetingId !== meetingId ||
        (decision && (decision.confirmRoute !== "meeting" || decision.meetingId !== meetingId))) return refuse("stale_preview");
  } else if (meetingId) {
    throw new Error("Billing confirmation cannot attach a meeting");
  }
  if (position === "system_loss" && decision) return refuse("needs_review");
  if (position === "won" && decision && !membership) return refuse("binding_invalid");
  if ((!proposal.programId || !proposal.paymentType) && (!args.programId || !args.paymentType)) {
    return refuse("program_required");
  }
  const programId = proposal.programId ?? args.programId;
  const paymentType = proposal.paymentType ?? args.paymentType;
  if (!programId || !paymentType) return refuse("program_required");
  if ((args.programId && args.programId !== programId) || (inheritedProgramId && inheritedProgramId !== programId) ||
      (membership && membership.anchor.programId !== programId)) return refuse("binding_invalid");
  if (args.paymentType && args.paymentType !== paymentType) return refuse("binding_invalid");
  const program = await ctx.db.get("tenantPrograms", programId);
  if (program?.tenantId !== tenantId || (kind === "payment_win" && program.archivedAt !== undefined)) {
    return refuse("program_required");
  }

  const latestActivityAt = deal.latestActivityAt ?? computeLatestActivityAt(deal);
  const before: Before = {
    position, systemLossReason: systemLoss ?? undefined, lostAt: deal.lostAt, latestActivityAt,
    meetings: kind === "payment_win"
      ? [...scheduled, ...meetings.filter((meeting) => meeting.status !== "scheduled")]
        .slice(0, ATTENDANCE_DEBT_MEETING_LIMIT).map((meeting) => ({ meetingId: meeting._id, status: meeting.status }))
      : [],
    tasks: expires.map((task) => ({ followUpId: task._id, status: task.status })),
  };
  const eventActor = { tenantId, source: approver.source, actorUserId: approver.userId };
  const { amountMinor, currency, attributedCloserId } = proposal;
  const paymentRecordId = await insertRecordedPayment(ctx, {
    tenantId, opportunityId, meetingId, amountMinor, currency, paymentType,
    attributedCloserId, recordedByUserId: approver.userId,
    programId, programName: program.name, recordedAt: now,
    origin: "provider", recordedVia: "provider", providerPaymentId, providerPaidAt: payment.paidAt,
  });
  const record = await ctx.db.get("paymentRecords", paymentRecordId);
  if (!record) throw new Error("New payment record missing");
  await setActiveAllocation(ctx, {
    payment, record, expectedAllocationRevision: args.expectedAllocationRevision, reviewState: "recorded",
    matchMethod: membership ? "membership_binding" : "person", actorUserId: approver.userId, now,
  });

  if (kind === "payment_win") {
    const exception = position === "system_loss" ? "provider_payment_after_system_loss" : undefined;
    await setSoldProgramCaches(ctx, { tenantId, opportunityId, meetingId, programId, programName: program.name });
    await transitionOpportunity(ctx, opportunityId, {
      to: { stage: "closed", outcome: "won" },
      fields: { paymentReceivedAt: now, updatedAt: now },
      source: approver.source, actorUserId: approver.userId, occurredAt: now,
      exception,
      metadata: { paymentId: paymentRecordId, providerPaymentId, decisionId: decision?._id, exception },
    });
    for (const task of expires) {
      await ctx.db.patch("followUps", task._id, { status: "expired" });
      await emitDomainEvent(ctx, {
        ...eventActor, entityType: "followUp", entityId: task._id, eventType: "followUp.expired",
        fromStatus: "pending", toStatus: "expired", occurredAt: now,
        metadata: { code: "deal_paid", opportunityId, paymentId: paymentRecordId, decisionId: decision?._id, type: task.type },
      });
    }
  } else {
    await patchOpportunityLifecycle(ctx, opportunityId, {
      updatedAt: deal.updatedAt, latestActivityAt: Math.max(latestActivityAt, now),
    });
    await syncPersonEnrollments(ctx, { ...eventActor, leadId: deal.leadId, now });
  }
  await emitDomainEvent(ctx, {
    ...eventActor, entityType: "payment", entityId: paymentRecordId, eventType: "payment.recorded",
    occurredAt: now, toStatus: "recorded",
    metadata: {
      opportunityId, meetingId, amountMinor, currency, programId, paymentType, attributedCloserId,
      recordedByUserId: approver.userId, origin: "provider", providerPaymentId,
      ...(kind === "additional_payment" && { additionalPayment: true }),
    },
  });
  if (kind === "payment_win") {
    await syncPersonEnrollments(ctx, { ...eventActor, leadId: deal.leadId, now });
    await markAttendanceOwed(ctx, opportunityId, { exceptMeetingId: meetingId });
  }
  const decisionId = await recordApplyReceipt(ctx, {
    tenantId, opportunityId, providerPaymentId, paymentRecordId, kind, before,
    decisionId: decision?._id, appliedVia: via, approverUserId: approver.userId, now,
  });
  await ctx.db.patch("paymentRecords", paymentRecordId, { automationDecisionId: decisionId });
  await addPinnedLine(ctx, {
    tenantId, userId: attributedCloserId, opportunityId, paymentRecordId, decisionId, amountMinor, currency,
    kind: kind === "payment_win" ? "win_recorded_from_whop" : "instalment_credited",
    dealPositionAfter: "won", createdAt: now,
  });
  await supersedePaymentDecisions(ctx, payment, decisionId);
  await noteHumanResult(ctx, opportunityId, { tenantId, userId: approver.userId }, { consumeDecisionId: decisionId });
  return { ok: true, alreadyApplied: false, paymentRecordId, decisionId };
}
