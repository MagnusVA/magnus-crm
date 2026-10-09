import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { applyStoredBookingFact } from "./storedBookingFact";

export const process = internalMutation({
  args: { tenantId: v.id("tenants"), payload: v.any(), rawEventId: v.id("rawWebhookEvents") },
  returns: v.null(),
  handler: async (ctx, args) => { await applyStoredBookingFact(ctx, args, "invitee_no_show.created"); return null; },
});

export const revert = internalMutation({
  args: { tenantId: v.id("tenants"), payload: v.any(), rawEventId: v.id("rawWebhookEvents") },
  returns: v.null(),
  handler: async (ctx, args) => { await applyStoredBookingFact(ctx, args, "invitee_no_show.deleted"); return null; },
});
