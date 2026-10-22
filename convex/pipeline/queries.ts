import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * Get a raw webhook event by ID.
 * Used by the pipeline processor to load the event payload.
 */
export const getRawEvent = internalQuery({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    const event = await ctx.db.get("rawWebhookEvents", rawEventId);
    return event;
  },
});

/**
 * Find a lead by email within a tenant.
 * Used by invitee.created to check if a returning lead already exists.
 */
export const getLeadByEmail = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    email: v.string(),
  },
  handler: async (ctx, { tenantId, email }) => {
    const lead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email)
      )
      .unique();
    return lead;
  },
});

/**
 * Find a meeting by Calendly event URI within a tenant.
 * Used by invitee.canceled and invitee_no_show to find the affected meeting.
 */
export const getMeetingByCalendlyEventUri = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyEventUri }) => {
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
      )
      .first();
    return meeting;
  },
});

/**
 * Find the CRM user (Closer) by their Calendly user URI within a tenant.
 * Used by invitee.created to resolve the assigned host to a CRM Closer.
 */
export const getUserByCalendlyUri = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyUserUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyUserUri }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyUserUri", calendlyUserUri)
      )
      .unique();
    return user;
  },
});

/**
 * Find event type config by Calendly event type URI.
 * Used by invitee.created to link opportunities to event type configurations.
 */
export const getEventTypeConfig = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventTypeUri: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyEventTypeUri }) => {
    const config = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", calendlyEventTypeUri)
      )
      .unique();
    return config;
  },
});
