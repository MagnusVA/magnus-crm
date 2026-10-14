import { enqueueDelivery } from "./delivery";
import { adoptRawDelivery } from "./receipts";
import { blockBooking, blockedReason, ignoreBooking, ignoredReason } from "./blocked";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { recordBookingFact, reconcileBookingFact } from "./bookingFacts";
import { isRecord } from "../lib/payloadExtraction";
import { classifyBookingHost } from "./bookingHost";
import { ignoreGroupEventDelivery } from "./bookingRelevance";
import { log } from "../lib/observability/log";

/**
 * A cancel or no-show for a booking without a meeting gets the outcome its
 * host gives the booking's invitee.created: a known non-closer host is
 * ignored, a host the CRM can't place is blocked with the same reason. Only a
 * closer's booking falls through to `booking_not_tracked`.
 */
async function settleFollowUpWithoutMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    rawEventId: Id<"rawWebhookEvents">;
    eventType: string;
    eventUri: string;
    payload: unknown;
  },
) {
  const meeting = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
      q.eq("tenantId", args.tenantId).eq("calendlyEventUri", args.eventUri),
    )
    .first();
  if (meeting) return;
  const { resolution, outcome } = await classifyBookingHost(
    ctx,
    args.tenantId,
    args.payload,
  );
  if (outcome.status === "blocked") blockBooking(outcome.reason);
  if (outcome.status !== "ignored") return;
  log.info("pipeline.follow_up.skipped", {
    reason: outcome.reason,
    eventType: args.eventType,
    tenantId: args.tenantId,
    rawEventId: args.rawEventId,
    closerResolution: resolution.resolution,
    hostCalendlyRole: resolution.hostCalendlyRole,
  });
  ignoreBooking(outcome.reason);
}

/** Follow-up outcomes that only mean "no meeting yet". They settle again once
 * the booking's invitee.created produces a meeting. */
const settlesWithMeeting: Record<"blocked" | "ignored", readonly string[]> = {
  blocked: ["booking_not_tracked", "host_not_linked", "host_inactive"],
  ignored: ["non_closer_host"],
};

/** A booking and its durable outcome commit in the same transaction. */
export const processRawEvent = internalMutation({
  args: {
    rawEventId: v.id("rawWebhookEvents"),
    generation: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { rawEventId, generation }) => {
    const raw = await ctx.db.get("rawWebhookEvents", rawEventId);
    let receipt = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_rawEventId", (q) => q.eq("rawEventId", rawEventId))
      .unique();
    if (
      !raw ||
      raw.processed ||
      (generation !== undefined && receipt?.generation !== generation)
    )
      return null;
    if (!receipt) receipt = await adoptRawDelivery(ctx, raw);
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw.payload);
    } catch {
      throw new Error("Invalid webhook JSON");
    }
    if (!isRecord(envelope) || !isRecord(envelope.payload))
      throw new Error("Missing webhook payload");
    if (receipt?.eventUri)
      await recordBookingFact(ctx, {
        tenantId: raw.tenantId,
        eventUri: receipt.eventUri,
        inviteeUri: receipt.inviteeUri,
        eventType: raw.eventType,
        occurredAt: receipt.occurredAt,
        payload: envelope.payload,
      });
    const isInviteeEvent = [
      "invitee.created",
      "invitee.canceled",
      "invitee_no_show.created",
      "invitee_no_show.deleted",
    ].includes(raw.eventType);
    if (isInviteeEvent && !receipt.eventUri)
      throw new Error("Missing scheduled event URI");
    const args = {
      tenantId: raw.tenantId,
      rawEventId,
      payload: envelope.payload,
    };
    let reason: string | undefined;
    try {
      if (isInviteeEvent)
        await ignoreGroupEventDelivery(ctx, {
          tenantId: raw.tenantId,
          rawEventId,
          eventType: raw.eventType,
          eventUri: receipt.eventUri!,
          inviteeUri: receipt.inviteeUri,
          payload: envelope.payload,
        });
      switch (raw.eventType) {
        case "invitee.created":
          await ctx.runMutation(internal.pipeline.inviteeCreated.process, args);
          break;
        case "invitee.canceled":
        case "invitee_no_show.created":
        case "invitee_no_show.deleted":
          await settleFollowUpWithoutMeeting(ctx, {
            ...args,
            eventType: raw.eventType,
            eventUri: receipt.eventUri!,
          });
          break;
        default:
          reason = "unsupported_event_type";
      }
    } catch (error) {
      reason = ignoredReason(error);
      if (!reason) {
        const blocked = blockedReason(error);
        if (!blocked || !receipt) throw error;
        await ctx.db.patch("webhookDeliveries", receipt._id, {
          status: "blocked",
          reason: blocked,
          processedAt: Date.now(),
        });
        return null;
      }
    }
    // An ignored delivery is not part of any tracked booking, even when its
    // scheduled event has a meeting (another registrant of a group event).
    if (!reason && receipt?.eventUri)
      await reconcileBookingFact(
        ctx,
        raw.tenantId,
        receipt.eventUri,
        receipt.inviteeUri,
      );
    const meeting = !reason && receipt?.eventUri
      ? await ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
            q
              .eq("tenantId", raw.tenantId)
              .eq("calendlyEventUri", receipt.eventUri!),
          )
          .unique()
      : null;
    if (
      meeting &&
      receipt &&
      meeting.calendlyInviteeUri !== receipt.inviteeUri
    ) {
      await ctx.db.patch("rawWebhookEvents", rawEventId, { processed: false });
      await ctx.db.patch("webhookDeliveries", receipt._id, {
        status: "blocked",
        reason: "ambiguous_booking_identity",
        processedAt: Date.now(),
      });
      return null;
    }
    if (meeting && receipt && raw.eventType === "invitee.created") {
      for (const status of ["blocked", "ignored"] as const) {
        const waiting = await ctx.db
          .query("webhookDeliveries")
          .withIndex("by_tenantId_and_inviteeUri_and_status", (q) =>
            q
              .eq("tenantId", raw.tenantId)
              .eq("inviteeUri", receipt.inviteeUri)
              .eq("status", status),
          )
          .take(64);
        for (const row of waiting) {
          if (
            row._id === receipt._id ||
            row.eventType === "invitee.created" ||
            row.eventUri !== receipt.eventUri ||
            !settlesWithMeeting[status].includes(row.reason ?? "")
          )
            continue;
          if (status === "ignored") {
            // An ignored payload may already be past retention.
            if (!(await ctx.db.get("rawWebhookEvents", row.rawEventId))) continue;
            await ctx.db.patch("rawWebhookEvents", row.rawEventId, {
              processed: false,
              processingReason: undefined,
            });
          }
          await enqueueDelivery(ctx, row._id);
        }
      }
    }
    const opportunity = meeting
      ? await ctx.db.get("opportunities", meeting.opportunityId)
      : null;
    await ctx.db.patch("rawWebhookEvents", rawEventId, {
      processed: Boolean(reason || meeting),
      processingReason: reason,
    });
    if (receipt)
      await ctx.db.patch("webhookDeliveries", receipt._id, {
        status: reason ? "ignored" : meeting ? "applied" : "blocked",
        reason: reason ?? (meeting ? undefined : "booking_not_tracked"),
        processedAt: Date.now(),
        meetingId: meeting?._id,
        opportunityId: opportunity?._id,
        leadId: opportunity?.leadId,
      });
    return null;
  },
});
