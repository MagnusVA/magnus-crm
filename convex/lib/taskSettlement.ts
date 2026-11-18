import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "./domainEvents";
import { earliestCountingPayment, paymentCounts } from "./enrollments";
import { insertManualReminder } from "./reminderInsert";

type Task = Doc<"followUps">;
type Payment = Doc<"paymentRecords">;
type TaskChange = Doc<"paymentCorrections">["tasks"][number];
type Actor = { source: "closer" | "admin" | "system"; actorUserId?: Id<"users"> };
type Settlement = Actor & {
  opportunityId: Id<"opportunities">;
  paymentRecordId: Id<"paymentRecords">;
  amountMinor: number;
  currency: string;
  now: number;
};

type TaskMetadata = Record<string, string | number | undefined>;

function qualifies(task: Task, currency: string): boolean {
  return task.purpose === "payment_owed" && task.expectedCurrency === currency;
}

function differenceMinor(task: Task, payment: Pick<Payment, "amountMinor" | "currency">) {
  if (!qualifies(task, payment.currency) || task.expectedAmountMinor === undefined) return undefined;
  const difference = payment.amountMinor - task.expectedAmountMinor;
  return difference === 0 ? undefined : difference;
}

async function closeTask(
  ctx: MutationCtx,
  task: Task,
  payment: Settlement,
  completed: boolean,
  metadata: TaskMetadata,
): Promise<void> {
  if (task.status !== "pending" || task.opportunityId !== payment.opportunityId) {
    throw new Error("Payment task is no longer pending on this deal");
  }
  const toStatus = completed ? "completed" : "expired";
  await ctx.db.patch("followUps", task._id, completed ? {
    status: toStatus,
    completedAt: payment.now,
    completionOutcome: "payment_received",
    completionPaymentId: payment.paymentRecordId,
  } : { status: toStatus });
  const difference = differenceMinor(task, payment);
  const promiseMetadata = completed && qualifies(task, payment.currency)
    ? {
        paymentId: payment.paymentRecordId,
        decisionId: task.automationDecisionId,
        expectedAmountMinor: task.expectedAmountMinor,
        paidAmountMinor: payment.amountMinor,
        differenceMinor: difference,
        code: difference === undefined ? undefined : "amount_differs",
      }
    : {};
  await emitDomainEvent(ctx, {
    tenantId: task.tenantId,
    source: payment.source,
    actorUserId: payment.actorUserId,
    entityType: "followUp",
    entityId: task._id,
    eventType: completed ? "followUp.completed" : "followUp.expired",
    fromStatus: "pending",
    toStatus,
    occurredAt: payment.now,
    metadata: {
      ...(completed ? { outcome: "payment_received" } : { code: "deal_paid" }),
      ...metadata,
      ...promiseMetadata,
    },
  });
}

/** Classify the same tasks for Billing's preview and for the provider writer. */
export function planProviderWinTasks(pending: readonly Task[], currency: string) {
  const completing: Task[] = [];
  const expiring: Task[] = [];
  for (const task of pending) {
    (qualifies(task, currency) ? completing : expiring).push(task);
  }
  return { completing, expiring };
}

async function completeTasks(ctx: MutationCtx, payment: Settlement, tasks: readonly Task[]) {
  for (const task of tasks) await closeTask(ctx, task, payment, true, {});
  return tasks.map((task) => task._id);
}

/** Complete promises on a deal's first counting payment. The caller owns the expiry rule. */
export async function completePaymentOwedTasks(
  ctx: MutationCtx,
  payment: Settlement,
): Promise<Id<"followUps">[]> {
  const tasks = await ctx.db.query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", payment.opportunityId).eq("status", "pending"))
    .take(21);
  if (tasks.length > 20) throw new Error("Too many pending tasks on deal");
  return await completeTasks(ctx, payment, planProviderWinTasks(tasks, payment.currency).completing);
}

/** Apply's first-payment rule. Complete promises and expire every other pending task. */
export async function settleProviderWinTasks(
  ctx: MutationCtx,
  payment: Settlement & { decisionId?: Id<"resultAutomationDecisions"> },
  pending: readonly Task[],
): Promise<void> {
  const { completing, expiring } = planProviderWinTasks(pending, payment.currency);
  await completeTasks(ctx, payment, completing);
  for (const task of expiring) {
    await closeTask(ctx, task, payment, false, {
      opportunityId: payment.opportunityId,
      paymentId: payment.paymentRecordId,
      decisionId: payment.decisionId,
      type: task.type,
    });
  }
}

/** The reminder that was worked when a closer or admin recorded the first payment. */
export async function settleReminderPaymentTask(
  ctx: MutationCtx,
  payment: Settlement,
  task: Task,
  metadata: TaskMetadata,
): Promise<void> {
  const completes = task.purpose !== "payment_owed" || qualifies(task, payment.currency);
  await closeTask(ctx, task, payment, completes, completes ? metadata : {
    ...metadata,
    paymentId: payment.paymentRecordId,
    opportunityId: payment.opportunityId,
  });
}

type FollowUpPlan =
  | { kind: "keep"; task: Task }
  | { kind: "reopen"; task: Task }
  | { kind: "create"; closerId: Id<"users">; contactMethod: "call" | "text" };

/** Write task changes after the exclusion writer has selected and validated its disposition. */
export async function settleExcludedPaymentTasks(
  ctx: MutationCtx,
  args: {
    opportunity: Doc<"opportunities">;
    completedTasks: readonly Task[];
    survivors: readonly Payment[];
    restoreTasks?: readonly Task[];
    followUp?: FollowUpPlan;
    followUpContactMethod?: "call" | "text";
    correctionId: Id<"paymentCorrections">;
    actorUserId: Id<"users">;
    now: number;
  },
): Promise<TaskChange[]> {
  const { opportunity, correctionId, actorUserId, now, followUp } = args;
  const changes: TaskChange[] = [];
  if (args.survivors.length > 0) {
    for (const task of args.completedTasks) {
      const replacement = earliestCountingPayment(task.purpose === "payment_owed"
        ? args.survivors.filter((row) => qualifies(task, row.currency))
        : args.survivors);
      // A win in a different currency leaves the historical completion on
      // the excluded payment. The reminder detail only shows counting cash.
      if (!replacement) continue;
      await ctx.db.patch("followUps", task._id, { completionPaymentId: replacement._id });
      changes.push({ followUpId: task._id, change: "repointed" });
    }
    return changes;
  }

  const reopen = async (task: Task, fields: Partial<Task> = {}) => {
    await ctx.db.patch("followUps", task._id, {
      status: "pending",
      completedAt: undefined,
      completionOutcome: undefined,
      completionPaymentId: undefined,
      ...fields,
    });
    changes.push({ followUpId: task._id, change: "reopened" });
  };

  if (args.restoreTasks) {
    for (const task of args.restoreTasks) await reopen(task);
  } else if (followUp?.kind === "reopen") {
    await reopen(followUp.task, {
      // A promise keeps its original due date. Reviewed ordinary reminders are due now.
      ...(followUp.task.purpose !== "payment_owed" && { reminderScheduledAt: now }),
      ...(args.followUpContactMethod && { contactMethod: args.followUpContactMethod }),
    });
  } else if (followUp?.kind === "create") {
    const followUpId = await insertManualReminder(ctx, {
      source: "admin",
      actorUserId,
      opportunity,
      closerId: followUp.closerId,
      contactMethod: followUp.contactMethod,
      reminderScheduledAt: now,
      reason: "admin_initiated",
      now,
      metadata: { correctionId },
    });
    changes.push({ followUpId, change: "created" });
  }
  return changes;
}

/** Resolve the pending tasks owned by the exclusion a payment restore is reversing. */
export async function settleRestoredPaymentTasks(
  ctx: MutationCtx,
  args: {
    payment: Payment;
    closeTasks: readonly { task: Task; change: TaskChange["change"] }[];
    winExpiredTaskIds: ReadonlySet<Id<"followUps">>;
    restoreId: Id<"paymentCorrections">;
    actorUserId: Id<"users">;
    now: number;
  },
): Promise<TaskChange[]> {
  const { payment, closeTasks, winExpiredTaskIds, restoreId, actorUserId, now } = args;
  const changes: TaskChange[] = [];
  for (const { task, change } of closeTasks) {
    if (task.opportunityId !== payment.opportunityId || task.tenantId !== payment.tenantId) {
      throw new Error("Task does not belong to the restored payment's deal");
    }
    const completes = task.purpose === "payment_owed"
      ? qualifies(task, payment.currency)
      : !winExpiredTaskIds.has(task._id) && task.type === "manual_reminder" && change === "reopened";
    await closeTask(ctx, task, {
      opportunityId: task.opportunityId,
      paymentRecordId: payment._id,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      source: "admin",
      actorUserId,
      now,
    }, completes, { paymentId: payment._id, correctionId: restoreId });
    changes.push({ followUpId: task._id, change: completes ? "completed" : "expired" });
  }
  return changes;
}

/** Counting payment and amount difference for a reminder's detail view. */
export function completedByPayment(task: Task, row: Payment | null) {
  if (!row || task.status !== "completed" || task.completionPaymentId !== row._id ||
      !paymentCounts(row) || row.tenantId !== task.tenantId ||
      row.opportunityId !== task.opportunityId) return null;
  const difference = differenceMinor(task, row);
  return {
    paymentRecordId: row._id,
    amountMinor: row.amountMinor,
    currency: row.currency,
    recordedAt: row.recordedAt,
    differenceMinor: difference ?? null,
    differenceCode: difference === undefined ? null : "amount_differs" as const,
  };
}
