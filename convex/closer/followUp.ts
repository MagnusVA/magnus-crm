"use node";

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { getValidAccessToken } from "../calendly/tokens";
import { validateTransition } from "../lib/statusTransitions";
import { getIdentityOrgId } from "../lib/identity";

type SchedulingLinkPayload = {
  resource?: {
    booking_url?: string;
  };
};

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function extractBookingUrl(payload: SchedulingLinkPayload): string | null {
  const bookingUrl = payload.resource?.booking_url;
  return typeof bookingUrl === "string" && bookingUrl.length > 0
    ? bookingUrl
    : null;
}

/**
 * Create a follow-up scheduling link for an opportunity.
 *
 * Flow:
 * 1. Validate caller is a closer with access to this opportunity
 * 2. Get a valid Calendly access token for the tenant
 * 3. Create a single-use scheduling link via Calendly API
 * 4. Create a followUps record (status: pending)
 * 5. Transition the opportunity to follow_up_scheduled
 * 6. Return the booking URL for the closer to share with the lead
 *
 * Note: This requires the scheduling_links:write Calendly scope.
 * If the scope is not available, this action will fail with a
 * clear error message.
 */
export const createFollowUp = action({
  args: {
    opportunityId: v.id("opportunities"),
    eventTypeUri: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { opportunityId, eventTypeUri },
  ): Promise<{ bookingUrl: string }> => {
    console.log("[Closer:FollowUp] createFollowUp called", { opportunityId, eventTypeUriProvided: !!eventTypeUri });
    // ==== Step 1: Validate caller ====
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const orgId = getIdentityOrgId(identity);
    if (!orgId) {
      throw new Error("No organization context");
    }

    const workosUserId = identity.tokenIdentifier ?? identity.subject;
    if (!workosUserId) {
      throw new Error("Missing WorkOS user ID");
    }

    const caller: Doc<"users"> | null = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    console.log("[Closer:FollowUp] caller validation", { found: !!caller, role: caller?.role });
    if (!caller || caller.role !== "closer") {
      throw new Error("Only closers can create follow-ups");
    }

    const tenant:
      | {
          _id: Id<"tenants">;
          workosOrgId: string;
        }
      | null = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: caller.tenantId,
    });
    if (!tenant || tenant.workosOrgId !== orgId) {
      throw new Error("Organization mismatch");
    }

    // Load the opportunity
    const opportunity: Doc<"opportunities"> | null = await ctx.runQuery(
      internal.opportunities.queries.getById,
      { opportunityId },
    );
    console.log("[Closer:FollowUp] opportunity validation", { found: !!opportunity, status: opportunity?.status, assignedCloserId: opportunity?.assignedCloserId });
    if (!opportunity || opportunity.tenantId !== caller.tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== caller._id) {
      throw new Error("Not your opportunity");
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    // ==== Step 2: Get valid Calendly access token ====
    const tokenState = await ctx.runQuery(
      internal.tenants.getCalendlyTokens,
      { tenantId: caller.tenantId },
    );
    console.log("[Closer:FollowUp] token state", { hasAccessToken: !!tokenState?.calendlyAccessToken });
    if (!tokenState?.calendlyAccessToken) {
      throw new Error(
        "Calendly is not connected. Please ask your admin to reconnect Calendly."
      );
    }

    const accessToken = await getValidAccessToken(ctx, caller.tenantId);
    if (!accessToken) {
      throw new Error(
        "Calendly token expired and could not be refreshed. Contact your admin.",
      );
    }

    // Determine which event type to use for the scheduling link
    const eventTypeConfig: Doc<"eventTypeConfigs"> | null =
      opportunity.eventTypeConfigId
        ? await ctx.runQuery(internal.eventTypeConfigs.queries.getById, {
            eventTypeConfigId: opportunity.eventTypeConfigId,
          })
        : null;
    const targetEventType =
      normalizeOptionalString(eventTypeUri) ??
      eventTypeConfig?.calendlyEventTypeUri;
    if (!targetEventType) {
      throw new Error(
        "No event type available for follow-up. Configure an event type or provide one explicitly.",
      );
    }

    // ==== Step 3: Create single-use scheduling link via Calendly API ====
    console.log("[Closer:FollowUp] Calendly API request", { endpoint: "scheduling_links", eventType: targetEventType });
    const response = await fetch("https://api.calendly.com/scheduling_links", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_event_count: 1,
        owner: targetEventType,
        owner_type: "EventType",
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 403) {
        throw new Error(
          "Missing Calendly scope: scheduling_links:write. " +
            "Please ask your admin to reconnect Calendly with the required scopes.",
        );
      }
      throw new Error(
        `Failed to create scheduling link: ${response.status} ${errorBody}`,
      );
    }

    const data = (await response.json()) as SchedulingLinkPayload;
    const bookingUrl = extractBookingUrl(data);
    console.log("[Closer:FollowUp] Calendly API response", { status: response.status, success: response.ok, hasBookingUrl: !!bookingUrl });
    if (!bookingUrl) {
      throw new Error("Calendly did not return a booking URL");
    }

    // ==== Step 4: Create follow-up record ====
    console.log("[Closer:FollowUp] creating follow-up record", { opportunityId, leadId: opportunity.leadId });
    await ctx.runMutation(
      internal.closer.followUpMutations.createFollowUpRecord,
      {
        tenantId: caller.tenantId,
        opportunityId,
        leadId: opportunity.leadId,
        closerId: caller._id,
        schedulingLinkUrl: bookingUrl,
        reason: "closer_initiated",
      },
    );

    // ==== Step 5: Transition opportunity status ====
    console.log("[Closer:FollowUp] transitioning opportunity to follow_up_scheduled", { opportunityId });
    await ctx.runMutation(
      internal.closer.followUpMutations.transitionToFollowUp,
      {
        opportunityId,
      },
    );

    console.log("[Closer:FollowUp] createFollowUp completed successfully", { opportunityId });
    return { bookingUrl };
  },
});
