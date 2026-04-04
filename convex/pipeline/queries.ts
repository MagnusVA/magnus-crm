import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/**
 * Get a raw webhook event by ID.
 * Used by the pipeline processor to load the event payload.
 */
export const getRawEvent = internalQuery({
  args: { rawEventId: v.id("rawWebhookEvents") },
  handler: async (ctx, { rawEventId }) => {
    console.log(`[Pipeline] getRawEvent | rawEventId=${rawEventId}`);
    const event = await ctx.db.get(rawEventId);
    console.log(`[Pipeline] getRawEvent | ${event ? `found, type=${event.eventType} processed=${event.processed}` : "not found"}`);
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
    console.log(`[Pipeline] getLeadByEmail | tenantId=${tenantId}`);
    const lead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email)
      )
      .unique();
    console.log(`[Pipeline] getLeadByEmail | ${lead ? `found, leadId=${lead._id}` : "not found"}`);
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
    console.log(`[Pipeline] getMeetingByCalendlyEventUri | tenantId=${tenantId} eventUri=${calendlyEventUri}`);
    const meeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri)
      )
      .first();
    console.log(`[Pipeline] getMeetingByCalendlyEventUri | ${meeting ? `found, meetingId=${meeting._id}` : "not found"}`);
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
    console.log(`[Pipeline] getUserByCalendlyUri | tenantId=${tenantId} userUri=${calendlyUserUri}`);
    const user = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyUserUri", calendlyUserUri)
      )
      .unique();
    console.log(`[Pipeline] getUserByCalendlyUri | ${user ? `found, userId=${user._id} role=${user.role}` : "not found"}`);
    return user;
  },
});

/**
 * Find an existing follow-up opportunity for a lead.
 * Used by invitee.created to detect if this is a follow-up booking.
 */
export const getFollowUpOpportunity = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, { tenantId, leadId }) => {
    console.log(`[Pipeline] getFollowUpOpportunity | tenantId=${tenantId} leadId=${leadId}`);
    const opportunities = ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc");

    for await (const opportunity of opportunities) {
      if (opportunity.status === "follow_up_scheduled") {
        console.log(`[Pipeline] getFollowUpOpportunity | found, opportunityId=${opportunity._id}`);
        return opportunity;
      }
    }

    console.log(`[Pipeline] getFollowUpOpportunity | not found`);
    return null;
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
    console.log(`[Pipeline] getEventTypeConfig | tenantId=${tenantId} eventTypeUri=${calendlyEventTypeUri}`);
    const config = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", calendlyEventTypeUri)
      )
      .unique();
    console.log(`[Pipeline] getEventTypeConfig | ${config ? `found, configId=${config._id}` : "not found"}`);
    return config;
  },
});
