import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
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
    now: number;
    metadata?: Record<string, string | number>;
  },
): Promise<Id<"followUps">> {
  const {
    opportunity: { _id: opportunityId, tenantId, leadId },
    closerId, contactMethod, reminderScheduledAt, reminderNote,
    sourceMeetingId, reason, now, source, actorUserId, metadata,
  } = args;
  const followUpId = await ctx.db.insert("followUps", {
    tenantId,
    opportunityId,
    leadId,
    closerId,
    type: "manual_reminder",
    contactMethod,
    reminderScheduledAt,
    reminderNote,
    reason,
    status: "pending",
    sourceMeetingId,
    createdAt: now,
    createdByUserId: actorUserId,
    createdSource: source,
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "followUp",
    entityId: followUpId,
    eventType: "followUp.created",
    source,
    actorUserId,
    toStatus: "pending",
    metadata: { type: "manual_reminder", opportunityId, ...metadata },
    occurredAt: now,
  });
  return followUpId;
}
