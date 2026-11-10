import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  assertCoreRole,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import { hasPermission, type Permission } from "../lib/permissions";
import { syncPersonEnrollments } from "../lib/enrollments";
import { log } from "../lib/observability/log";
import { toAmountMinor } from "../lib/formatMoney";
import { requireActiveProgram } from "../lib/paymentHelpers";
import { refreshSoldProgramCachesForPaymentContext } from "../lib/soldProgramCache";
import { replacePaymentAggregate } from "../reporting/writeHooks";
import { countBillingPayments, replaceBillingPaymentAggregates } from "./aggregates";
import {
  normalizeExportFilters,
  normalizeExportLimit,
} from "./export";
import {
  BillingOpsDisabledError,
  requireBillingOpsEnabled,
  requireBillingPermission,
} from "./guards";
import {
  correctPaymentArgsValidator,
  correctPaymentReturnValidator,
  exportPaymentsArgsValidator,
} from "./validators";

type PaymentPatch = Partial<Omit<Doc<"paymentRecords">, "_id" | "_creationTime">>;
type PaymentKey = keyof Doc<"paymentRecords">;

const FINANCIAL_CORRECTION_KEYS = new Set<PaymentKey>([
  "amountMinor",
  "paymentType",
  "programId",
  "programName",
]);

function addChangedKey(changedKeys: PaymentKey[], key: PaymentKey) {
  if (!changedKeys.includes(key)) {
    changedKeys.push(key);
  }
}

function hasChangedKey(changedKeys: PaymentKey[], keys: Set<PaymentKey>) {
  return changedKeys.some((key) => keys.has(key));
}

function buildCorrectionMetadata(
  before: Doc<"paymentRecords">,
  after: Doc<"paymentRecords">,
  changedKeys: PaymentKey[],
  options: { returnedToReview: boolean },
) {
  const changed: Record<string, unknown> = {};
  for (const key of changedKeys) {
    changed[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  changed.returnedToReview = options.returnedToReview;
  return changed;
}

function clampExportedCount(exportedCount: number, limit: number) {
  const parsed = Math.trunc(exportedCount);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(parsed, limit));
}

async function refreshPaymentCorrectionSideEffects(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    before: Doc<"paymentRecords">;
    paymentRecordId: Id<"paymentRecords">;
    changedKeys: PaymentKey[];
  },
) {
  const after = await replacePaymentAggregate(
    ctx,
    args.before,
    args.paymentRecordId,
  );

  if (args.changedKeys.includes("programId")) {
    await refreshSoldProgramCachesForPaymentContext(ctx, {
      tenantId: args.tenantId,
      payment: after,
    });
  }

  return after;
}

const BILLING_ROLES = ["tenant_master", "tenant_admin"] as const;

/**
 * What `requireBillingPermission` and `requireBillingOpsEnabled` check on the
 * web, for a core whose actor came from elsewhere.
 */
async function assertBillingActor(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  permission: Permission,
) {
  assertCoreRole(actor, BILLING_ROLES);
  if (!hasPermission(actor.role, permission)) {
    throw new Error("Insufficient Billing permissions.");
  }
  await requireBillingOpsEnabled(ctx, actor.tenantId);
}

/** `toCheckResult`, plus the Billing Ops switch's own error class. */
async function toBillingCheckResult<T extends object>(
  check: () => Promise<T>,
): Promise<CheckResult<T>> {
  try {
    return await toCheckResult(check);
  } catch (error) {
    if (error instanceof BillingOpsDisabledError) {
      return { ok: false, code: "billing.ops_disabled", message: error.message };
    }
    throw error;
  }
}

export type MarkReviewedArgs = { paymentRecordId: Id<"paymentRecords"> };

/** Every check `markReviewed` makes, in its order, with no write. */
async function checkMarkReviewed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  { paymentRecordId }: MarkReviewedArgs,
) {
  await assertBillingActor(ctx, actor, "billing:review");
  const payment = await ctx.db.get("paymentRecords", paymentRecordId);
  if (!payment || payment.tenantId !== actor.tenantId) {
    throw new Error("Payment not found.");
  }
  if (payment.status === "disputed") {
    throw new Error("Disputed payments cannot be marked reviewed.");
  }
  return { payment };
}

/**
 * Whether `markReviewedCore` would mark this payment reviewed, without
 * writing. `alreadyReviewed` means the core would write nothing.
 */
export async function checkMarkReviewedAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: MarkReviewedArgs,
): Promise<
  CheckResult<{
    paymentRecordId: Id<"paymentRecords">;
    status: Doc<"paymentRecords">["status"];
    alreadyReviewed: boolean;
  }>
> {
  return await toBillingCheckResult(async () => {
    const { payment } = await checkMarkReviewed(ctx, actor, args);
    return {
      paymentRecordId: payment._id,
      status: payment.status,
      alreadyReviewed: payment.status === "verified",
    };
  });
}

/**
 * Marks a payment reviewed: the core of `markReviewed`. It checks Billing
 * Ops and `billing:review` itself. `provenance` tags the `payment.verified`
 * event for an agent.
 */
export async function markReviewedCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: MarkReviewedArgs,
  provenance: Provenance,
): Promise<null> {
  const { paymentRecordId } = args;
  const { tenantId, userId } = actor;
  const { payment } = await checkMarkReviewed(ctx, actor, args);
  if (payment.status === "verified") {
    log.info("billing.payment.review_skipped", {
      tenantId,
      paymentRecordId,
      reason: "already_verified",
    });
    return null;
  }

  const now = Date.now();
  const reviewPatch = {
    status: "verified" as const,
    verifiedAt: now,
    verifiedByUserId: userId,
    statusChangedAt: now,
  };
  const reviewedPayment = { ...payment, ...reviewPatch };

  await ctx.db.patch("paymentRecords", paymentRecordId, reviewPatch);
  await replaceBillingPaymentAggregates(ctx, payment, reviewedPayment);

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "payment",
    entityId: paymentRecordId,
    eventType: "payment.verified",
    source: "admin",
    actorUserId: userId,
    fromStatus: payment.status,
    toStatus: "verified",
    occurredAt: now,
    metadata: {
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      paymentType: payment.paymentType,
      programId: payment.programId,
      programName: payment.programName,
      ...provenanceMetadata(provenance),
    },
  });

  return null;
}

export const markReviewed = mutation({
  args: { paymentRecordId: v.id("paymentRecords") },
  returns: v.null(),
  handler: async (ctx, { paymentRecordId }) => {
    const actor = await requireBillingPermission(ctx, "billing:review");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    return await markReviewedCore(ctx, actor, { paymentRecordId }, WEB);
  },
});

export type CorrectPaymentArgs = ObjectType<typeof correctPaymentArgsValidator>;

/**
 * Every check `correctPayment` makes, in its order, and the patch it would
 * write, with no write.
 */
async function planCorrection(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: CorrectPaymentArgs,
) {
  await assertBillingActor(ctx, actor, "billing:correct");
  const { tenantId } = actor;

  const payment = await ctx.db.get("paymentRecords", args.paymentRecordId);
  if (!payment || payment.tenantId !== tenantId) {
    throw new Error("Payment not found.");
  }
  if (payment.status === "disputed") {
    throw new Error("Disputed payments must be repaired through a dispute flow.");
  }

  const reason = args.reason.trim();
  if (!reason) {
    throw new Error("A correction reason is required.");
  }

  const patch: PaymentPatch = {};
  const changedKeys: PaymentKey[] = [];

  if (args.amount !== undefined) {
    const amountMinor = toAmountMinor(args.amount);
    if (amountMinor !== payment.amountMinor) {
      patch.amountMinor = amountMinor;
      addChangedKey(changedKeys, "amountMinor");
    }
  }

  if (
    args.paymentType !== undefined &&
    args.paymentType !== payment.paymentType
  ) {
    patch.paymentType = args.paymentType;
    addChangedKey(changedKeys, "paymentType");
  }

  if (args.programId !== undefined && args.programId !== payment.programId) {
    const program = await requireActiveProgram(ctx, tenantId, args.programId);
    patch.programId = program._id;
    patch.programName = program.name;
    addChangedKey(changedKeys, "programId");
    addChangedKey(changedKeys, "programName");
  }

  if (args.referenceCode !== undefined) {
    const nextReferenceCode = args.referenceCode.trim() || undefined;
    if (nextReferenceCode !== payment.referenceCode) {
      patch.referenceCode = nextReferenceCode;
      addChangedKey(changedKeys, "referenceCode");
    }
  }

  if (args.note !== undefined) {
    const nextNote = args.note.trim() || undefined;
    if (nextNote !== payment.note) {
      patch.note = nextNote;
      addChangedKey(changedKeys, "note");
    }
  }

  const financialChange = hasChangedKey(changedKeys, FINANCIAL_CORRECTION_KEYS);
  const returnedToReview = financialChange && payment.status === "verified";
  return { payment, reason, patch, changedKeys, returnedToReview };
}

/**
 * Whether `correctPaymentCore` would accept this correction, without
 * writing. `changed: false` means it would write nothing.
 */
export async function checkCorrectPaymentAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: CorrectPaymentArgs,
): Promise<
  CheckResult<{
    paymentRecordId: Id<"paymentRecords">;
    status: Doc<"paymentRecords">["status"];
    changedKeys: PaymentKey[];
    changed: boolean;
    returnedToReview: boolean;
  }>
> {
  return await toBillingCheckResult(async () => {
    const plan = await planCorrection(ctx, actor, args);
    return {
      paymentRecordId: plan.payment._id,
      status: plan.payment.status,
      changedKeys: plan.changedKeys,
      changed: plan.changedKeys.length > 0,
      returnedToReview: plan.returnedToReview,
    };
  });
}

function formatAmount(amountMinor: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
      amountMinor / 100,
    );
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * What the correction would do, in plain sentences, computed without
 * writing. The same payment and arguments give the same lines, so a preview
 * can pin them and a commit compare them. Reference codes and notes are
 * named, never quoted.
 *
 * A program change re-derives the person's enrollments from their payments
 * (`syncPersonEnrollments`), which has no step that previews its result, so
 * that line says the enrollments are re-derived rather than which ones
 * change. Every other field changes no enrollment.
 */
export async function describeCorrectionEffects(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: CorrectPaymentArgs,
): Promise<string[]> {
  const { payment, patch, changedKeys, returnedToReview } = await planCorrection(
    ctx,
    actor,
    args,
  );
  if (changedKeys.length === 0) {
    return ["Nothing changes: every field already has this value."];
  }
  const lines: string[] = [];
  if (patch.amountMinor !== undefined) {
    lines.push(
      `Amount: ${formatAmount(payment.amountMinor, payment.currency)} → ${formatAmount(patch.amountMinor, payment.currency)}.`,
    );
  }
  if (patch.paymentType !== undefined) {
    lines.push(`Payment type: ${payment.paymentType} → ${patch.paymentType}.`);
  }
  if (patch.programId !== undefined) {
    lines.push(`Program: ${payment.programName} → ${patch.programName}.`);
  }
  if (changedKeys.includes("referenceCode")) {
    lines.push(
      patch.referenceCode === undefined
        ? "Reference code: cleared."
        : payment.referenceCode === undefined
          ? "Reference code: added."
          : "Reference code: replaced.",
    );
  }
  if (changedKeys.includes("note")) {
    lines.push(
      patch.note === undefined
        ? "Note: cleared."
        : payment.note === undefined
          ? "Note: added."
          : "Note: replaced.",
    );
  }
  lines.push(
    returnedToReview
      ? "Review: the payment goes back to Needs review; its reviewed mark is removed."
      : `Review: unchanged (${payment.status === "verified" ? "reviewed" : "needs review"}).`,
  );
  lines.push(
    patch.programId !== undefined
      ? payment.opportunityId
        ? `Enrollments: the person's enrollments are re-derived from their payments, with this payment counting toward ${patch.programName} instead of ${payment.programName}.`
        : "Enrollments: none; this payment has no deal."
      : "Enrollments: unchanged.",
  );
  return lines;
}

/**
 * Corrects a payment's details: the core of `correctPayment`. It checks
 * Billing Ops and `billing:correct` itself. `provenance` tags the
 * `payment.corrected` event for an agent.
 */
export async function correctPaymentCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: CorrectPaymentArgs,
  provenance: Provenance,
): Promise<{
  paymentRecordId: Id<"paymentRecords">;
  status: Doc<"paymentRecords">["status"];
  returnedToReview: boolean;
  changed: boolean;
}> {
  const { tenantId, userId } = actor;
  const { payment, reason, patch, changedKeys, returnedToReview } =
    await planCorrection(ctx, actor, args);

  if (changedKeys.length === 0) {
    log.info("billing.payment.correction_skipped", {
      tenantId,
      paymentRecordId: args.paymentRecordId,
      reason: "no_changes",
    });
    return {
      paymentRecordId: args.paymentRecordId,
      status: payment.status,
      returnedToReview: false,
      changed: false,
    };
  }

  const now = Date.now();
  if (returnedToReview) {
    patch.status = "recorded";
    patch.verifiedAt = undefined;
    patch.verifiedByUserId = undefined;
    patch.statusChangedAt = now;
  }

  await ctx.db.patch("paymentRecords", args.paymentRecordId, patch);
  const nextPayment = await refreshPaymentCorrectionSideEffects(ctx, {
    tenantId,
    before: payment,
    paymentRecordId: args.paymentRecordId,
    changedKeys,
  });
  // A program correction moves the payment to its new program's enrollment,
  // and an enrollment it empties moves with it when the new program had
  // none (docs/plans/phase-4-customers.md §4.6). Other fields change no
  // enrollment; the sync still rebuilds the search row, whose total an
  // amount correction changes.
  if (nextPayment.opportunityId) {
    const opportunity = await ctx.db.get("opportunities", nextPayment.opportunityId);
    if (opportunity && opportunity.tenantId === tenantId) {
      await syncPersonEnrollments(ctx, {
        tenantId,
        leadId: opportunity.leadId,
        now,
        source: "admin",
        actorUserId: userId,
      });
    }
  }

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "payment",
    entityId: args.paymentRecordId,
    eventType: "payment.corrected",
    source: "admin",
    actorUserId: userId,
    fromStatus: payment.status,
    toStatus: nextPayment.status,
    reason,
    occurredAt: now,
    metadata: {
      ...buildCorrectionMetadata(payment, nextPayment, changedKeys, {
        returnedToReview,
      }),
      ...provenanceMetadata(provenance),
    },
  });

  return {
    paymentRecordId: args.paymentRecordId,
    status: nextPayment.status,
    returnedToReview,
    changed: true,
  };
}

export const correctPayment = mutation({
  args: correctPaymentArgsValidator,
  returns: correctPaymentReturnValidator,
  handler: async (ctx, args) => {
    const actor = await requireBillingPermission(ctx, "billing:correct");
    await requireBillingOpsEnabled(ctx, actor.tenantId);
    return await correctPaymentCore(ctx, actor, args, WEB);
  },
});

export const recordExportAudit = mutation({
  args: {
    ...exportPaymentsArgsValidator,
    exportedCount: v.number(),
    truncated: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:export",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const program = args.programId ? await ctx.db.get("tenantPrograms", args.programId) : null;
    if (args.programId && (!program || program.tenantId !== tenantId)) {
      throw new Error("Program not found.");
    }

    const limit = normalizeExportLimit(args.limit);
    const filters = {
      status: args.status,
      programId: args.programId,
      paymentType: args.paymentType,
      startAt: args.startAt,
      endAt: args.endAt,
    };
    const exactCount = await countBillingPayments(ctx, tenantId, filters);
    const exportedCount = Math.min(
      clampExportedCount(args.exportedCount, limit),
      exactCount,
    );
    const truncated = exactCount > limit;

    return await ctx.db.insert("billingExportEvents", {
      tenantId,
      actorUserId: userId,
      filtersJson: normalizeExportFilters({
        ...filters,
        programName: program?.name,
        limit,
      }),
      exactCount,
      exportedCount,
      truncated,
      createdAt: Date.now(),
    });
  },
});
