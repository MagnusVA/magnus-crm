import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AutomationCoreOptions } from "./outcomeCores";
import { emitDomainEvent } from "./domainEvents";

type ReminderActor =
  | { source: "closer" | "admin"; actorUserId: Id<"users"> }
  | { source: "system"; actorUserId?: never };

/** Creates the reminder and its event. The caller validates the scheduled time. */
export async function insertManualReminder(
  ctx: MutationCtx,
  args: ReminderActor & {
    opportunity: Pick<Doc<"opportunities">, "_id" | "tenantId" | "leadId">;
    closerId: Id<"users">;
    contactMethod: "call" | "text";
    reminderScheduledAt: number;
    reminderNote?: string;
    sourceMeetingId?: Id<"meetings">;
    reason: Doc<"followUps">["reason"];
    task?: AutomationCoreOptions["task"];
    automationDecisionId?: Id<"resultAutomationDecisions">;
    now: number;
    metadata?: Record<string, string | number>;
  },
): Promise<Id<"followUps">> {
  const {
    opportunity: { _id: opportunityId, tenantId, leadId },
    closerId, contactMethod, reminderScheduledAt, reminderNote,
    sourceMeetingId, reason, now, source, actorUserId, metadata, task, automationDecisionId,
  } = args;
  if (task?.purpose === "payment_owed" && (
    !Number.isSafeInteger(task.expectedAmountMinor) || (task.expectedAmountMinor ?? 0) <= 0 ||
    !/^[A-Z]{3}$/.test(task.expectedCurrency ?? "") || !Number.isFinite(task.promisedPaymentAt)
  )) throw new Error("Invalid payment promise");
  if (task?.declineCode !== undefined && !/^[a-z_]+$/.test(task.declineCode)) {
    throw new Error("Invalid payment decline code");
  }

  const followUpId = await ctx.db.insert("followUps", {
    tenantId,
    opportunityId,
    leadId,
    closerId,
    type: "manual_reminder",
    contactMethod,
    reminderScheduledAt,
    reminderNote: automationDecisionId ? undefined : reminderNote,
    reason,
    status: "pending",
    sourceMeetingId,
    createdAt: now,
    createdByUserId: actorUserId,
    createdSource: source,
    purpose: task?.purpose,
    expectedAmountMinor: task?.expectedAmountMinor,
    expectedCurrency: task?.expectedCurrency,
    promisedPaymentAt: task?.promisedPaymentAt,
    declineCode: task?.declineCode,
    automationDecisionId,
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "followUp",
    entityId: followUpId,
    eventType: "followUp.created",
    source,
    actorUserId,
    toStatus: "pending",
    metadata: {
      type: "manual_reminder",
      opportunityId,
      decisionId: automationDecisionId,
      purpose: task?.purpose,
      ...metadata,
    },
    occurredAt: now,
  });
  return followUpId;
}
