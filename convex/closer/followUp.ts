"use node";

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { getValidAccessToken } from "../calendly/tokens";
import { validateTransition } from "../lib/statusTransitions";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { log } from "../lib/observability/log";
import { rejectRequest } from "../lib/observability/errors";

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
    // ==== Step 1: Validate caller ====
    const caller = await requireTenantUserFromAction(ctx, ["closer"]);

    // Load the opportunity
    const opportunity: Doc<"opportunities"> | null = await ctx.runQuery(
      internal.opportunities.queries.getById,
      { opportunityId },
    );
    if (!opportunity || opportunity.tenantId !== caller.tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== caller.userId) {
      throw new Error("Not your opportunity");
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    // ==== Step 2: Get valid Calendly access token ====
    const connectionState = await ctx.runQuery(
      internal.calendly.connectionQueries.getTenantConnectionContext,
      { tenantId: caller.tenantId },
    );
    if (!connectionState?.accessToken) {
      throw rejectRequest(
        "calendly.not_connected",
        "Calendly is not connected. Please ask your admin to reconnect Calendly.",
        { tenantId: caller.tenantId, opportunityId },
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
    const calendlyResponseAttrs = {
      tenantId: caller.tenantId,
      opportunityId,
      actor: "closer",
      httpStatus: response.status,
    };
    if (response.ok) {
      log.info("follow_up.calendly_scheduling_link", calendlyResponseAttrs);
    } else {
      log.warn("follow_up.calendly_scheduling_link", calendlyResponseAttrs);
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          "Missing Calendly scope: scheduling_links:write. " +
            "Please ask your admin to reconnect Calendly with the required scopes.",
        );
      }
      // The body can echo request details, so only the status is kept.
      throw new Error(
        `Calendly scheduling link failed: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as SchedulingLinkPayload;
    const bookingUrl = extractBookingUrl(data);
    if (!bookingUrl) {
      throw new Error("Calendly did not return a booking URL");
    }

    // ==== Step 4: Create follow-up record ====
    await ctx.runMutation(
      internal.closer.followUpMutations.createFollowUpRecord,
      {
        tenantId: caller.tenantId,
        opportunityId,
        leadId: opportunity.leadId,
        closerId: caller.userId,
        schedulingLinkUrl: bookingUrl,
        reason: "closer_initiated",
      },
    );

    // ==== Step 5: Transition opportunity status ====
    await ctx.runMutation(
      internal.closer.followUpMutations.transitionToFollowUp,
      {
        opportunityId,
      },
    );

    return { bookingUrl };
  },
});
