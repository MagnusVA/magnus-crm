import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { emitDomainEvent } from "../lib/domainEvents";
import { getString, isRecord } from "../lib/payloadExtraction";
import { bookingFactMovesDeal } from "./bookingTargets";

export async function recordBookingFact(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventUri?: string;
    inviteeUri: string;
    eventType: string;
    occurredAt: number;
    payload: unknown;
  },
) {
  if (
    !args.eventUri ||
    ![
      "invitee.canceled",
      "invitee_no_show.created",
      "invitee_no_show.deleted",
    ].includes(args.eventType)
  )
    return;
  const row = await ctx.db
    .query("calendlyBookingFacts")
    .withIndex("by_tenantId_and_eventUri_and_inviteeUri", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("eventUri", args.eventUri!)
        .eq("inviteeUri", args.inviteeUri),
    )
    .unique();
  const patch =
    args.eventType === "invitee.canceled"
      ? {
          canceledAt: Math.min(row?.canceledAt ?? Infinity, args.occurredAt),
          cancellationReason:
            isRecord(args.payload) && isRecord(args.payload.cancellation)
              ? getString(args.payload.cancellation, "reason")
              : undefined,
          // Kept once seen: the processor records the fact again from the
          // same delivery, and a fact recorded before the field existed
          // gains it then.
          rescheduled:
            row?.rescheduled === true ||
            (isRecord(args.payload) && args.payload.rescheduled === true),
        }
      : args.occurredAt > (row?.noShowAt ?? -Infinity) ||
          (args.occurredAt === row?.noShowAt &&
            args.eventType === "invitee_no_show.deleted")
        ? {
            noShowAt: args.occurredAt,
            noShow: args.eventType === "invitee_no_show.created",
          }
        : {};
  if (row) await ctx.db.patch("calendlyBookingFacts", row._id, patch);
  else
    await ctx.db.insert("calendlyBookingFacts", {
      tenantId: args.tenantId,
      eventUri: args.eventUri,
      inviteeUri: args.inviteeUri,
      ...patch,
    });
}

/** Cancellation is permanent for an invitee. A newer booking has a different URI.
 * Reversal only undoes a provider no-show, never a closer's recorded outcome.
 * A cancel Calendly flags `rescheduled` cancels the meeting and leaves the deal. */
export async function reconcileBookingFact(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  eventUri: string,
  inviteeUri: string,
) {
  const fact = await ctx.db
    .query("calendlyBookingFacts")
    .withIndex("by_tenantId_and_eventUri_and_inviteeUri", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("eventUri", eventUri)
        .eq("inviteeUri", inviteeUri),
    )
    .unique();
  const meeting = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyEventUri", eventUri),
    )
    .unique();
  if (!meeting || !fact) return;
  // Keep the other invitee's fact, but let the processor block the delivery.
  // A shared scheduled-event URI alone cannot identify a person's booking.
  if (meeting.calendlyInviteeUri !== inviteeUri) return;
  const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId)
    throw new Error("Invalid booking relationship");
  let status = meeting.status;
  let occurredAt: number | undefined;
  if (
    fact.canceledAt !== undefined &&
    (status === "scheduled" ||
      (status === "no_show" && meeting.noShowSource === "calendly_webhook"))
  ) {
    status = "canceled";
    occurredAt = fact.canceledAt;
  } else if (fact.canceledAt === undefined && fact.noShowAt !== undefined) {
    if (fact.noShow && status === "scheduled") {
      status = "no_show";
      occurredAt = fact.noShowAt;
    }
    if (
      !fact.noShow &&
      status === "no_show" &&
      meeting.noShowSource === "calendly_webhook"
    ) {
      status = "scheduled";
      occurredAt = fact.noShowAt;
    }
  }
  if (
    status === meeting.status ||
    status === "completed" ||
    occurredAt === undefined
  )
    return;
  await patchMeetingLifecycle(ctx, meeting._id, {
    status,
    canceledAt: status === "canceled" ? occurredAt : meeting.canceledAt,
    noShowMarkedAt: status === "no_show" ? occurredAt : undefined,
    noShowSource: status === "no_show" ? "calendly_webhook" : undefined,
  });
  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "meeting",
    entityId: meeting._id,
    eventType:
      status === "scheduled" ? "meeting.no_show_reverted" : `meeting.${status}`,
    source: "pipeline",
    fromStatus: meeting.status,
    toStatus: status,
    occurredAt,
  });
  // A Calendly reschedule moves the booking, it doesn't cancel the deal: the
  // new invitee's invitee.created names this one in `old_invitee` and moves
  // the deal to it, whichever of the two is processed first.
  if (status === "canceled" && fact.rescheduled) return;
  // An old booking's cancellation must not cancel a newer reschedule or a sale.
  const currentBooking =
    opportunity.calendlyEventUri === eventUri ||
    (!opportunity.calendlyEventUri &&
      opportunity.latestMeetingId === meeting._id);
  // The facts move a Booked deal (or a side deal's Call held) and one a
  // missed meeting closed, when the deal doesn't already say what the
  // meeting now says.
  if (currentBooking && bookingFactMovesDeal(opportunity, status)) {
    await transitionOpportunity(ctx, opportunity._id, {
      to: status,
      fields: {
        canceledAt: status === "canceled" ? occurredAt : opportunity.canceledAt,
        cancellationReason:
          status === "canceled"
            ? fact.cancellationReason
            : opportunity.cancellationReason,
        noShowAt: status === "no_show" ? occurredAt : undefined,
        updatedAt: Math.max(opportunity.updatedAt, occurredAt),
      },
      // The opportunity mirrors the current booking, so it follows Calendly
      // between scheduled, no-show and canceled in whatever order the facts
      // arrive.
      exception: "calendly_webhook",
      source: "pipeline",
      occurredAt,
    });
  }
}
