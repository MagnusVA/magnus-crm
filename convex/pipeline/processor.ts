import { enqueueDelivery } from "./delivery";
import { adoptRawDelivery } from "./receipts";
import { blockedReason } from "./blocked";
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { recordBookingFact, reconcileBookingFact } from "./bookingFacts";
import { isRecord } from "../lib/payloadExtraction";

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
    if (
      [
        "invitee.created",
        "invitee.canceled",
        "invitee_no_show.created",
        "invitee_no_show.deleted",
      ].includes(raw.eventType) &&
      !receipt.eventUri
    )
      throw new Error("Missing scheduled event URI");
    const args = {
      tenantId: raw.tenantId,
      rawEventId,
      payload: envelope.payload,
    };
    let reason: string | undefined;
    try {
      switch (raw.eventType) {
        case "invitee.created":
          await ctx.runMutation(internal.pipeline.inviteeCreated.process, args);
          break;
        case "invitee.canceled":
          break;
        case "invitee_no_show.created":
          break;
        case "invitee_no_show.deleted":
          break;
        default:
          reason = "unsupported_event_type";
      }
    } catch (error) {
      const reason = blockedReason(error);
      if (!reason || !receipt) throw error;
      await ctx.db.patch("webhookDeliveries", receipt._id, {
        status: "blocked",
        reason,
        processedAt: Date.now(),
      });
      return null;
    }
    if (receipt?.eventUri)
      await reconcileBookingFact(
        ctx,
        raw.tenantId,
        receipt.eventUri,
        receipt.inviteeUri,
      );
    const meeting = receipt?.eventUri
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
      const waiting = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_tenantId_and_inviteeUri_and_status", (q) =>
          q
            .eq("tenantId", raw.tenantId)
            .eq("inviteeUri", receipt.inviteeUri)
            .eq("status", "blocked"),
        )
        .take(64);
      for (const row of waiting) {
        if (
          row._id !== receipt._id &&
          row.reason === "booking_not_tracked" &&
          row.eventUri === receipt.eventUri
        )
          await enqueueDelivery(ctx, row._id);
      }
    }
    const opportunity = meeting
      ? await ctx.db.get("opportunities", meeting.opportunityId)
      : null;
    reason ??= (await ctx.db.get("rawWebhookEvents", rawEventId))
      ?.processingReason;
    await ctx.db.patch("rawWebhookEvents", rawEventId, {
      processed: Boolean(reason || meeting),
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
