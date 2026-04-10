import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateTransition } from "../lib/statusTransitions";
import { extractUtmParams } from "../lib/utmParams";
import { extractMeetingLocation } from "../lib/meetingLocation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function extractQuestionsAndAnswers(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const question = getString(item, "question");
    const answer = getString(item, "answer");
    if (question && answer) {
      result[question] = answer;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeCustomFields(
  existing: Doc<"leads">["customFields"],
  incoming: Record<string, string> | undefined,
) {
  if (!incoming) {
    return existing;
  }

  if (isRecord(existing)) {
    return { ...existing, ...incoming };
  }

  return incoming;
}

async function resolveAssignedCloserId(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  hostUserUri: string | undefined,
): Promise<Id<"users"> | undefined> {
  console.log(`[Pipeline:invitee.created] Resolving closer | hostUserUri=${hostUserUri ?? "none"}`);

  if (!hostUserUri) {
    console.warn("[Pipeline:invitee.created] No host URI on scheduled event; leaving opportunity unassigned");
    return undefined;
  }

  const directUser = await ctx.db
    .query("users")
    .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
    )
    .unique();
  if (directUser?.role === "closer") {
    console.log(`[Pipeline:invitee.created] Direct user match: userId=${directUser._id}`);
    return directUser._id;
  }

  const orgMember = await ctx.db
    .query("calendlyOrgMembers")
    .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
    )
    .unique();
  if (orgMember?.matchedUserId) {
    const matchedUser = await ctx.db.get(orgMember.matchedUserId);
    if (matchedUser?.role === "closer") {
      console.log(`[Pipeline:invitee.created] Org member match: userId=${matchedUser._id} via orgMemberId=${orgMember._id}`);
      return matchedUser._id;
    }
  }

  console.warn(
    `[Pipeline:invitee.created] Unmatched Calendly host URI: ${hostUserUri}. Leaving opportunity unassigned.`,
  );
  return undefined;
}

export const process = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    console.log(`[Pipeline:invitee.created] Entry | tenantId=${tenantId} rawEventId=${rawEventId}`);

    const rawEvent = await ctx.db.get(rawEventId);
    if (!rawEvent || rawEvent.processed) {
      console.log(`[Pipeline:invitee.created] Skipping: event already processed or not found`);
      return;
    }

    if (!isRecord(payload) || !isRecord(payload.scheduled_event)) {
      throw new Error("[Pipeline] Invalid invitee.created payload");
    }

    const inviteeEmail = getString(payload, "email")?.toLowerCase();
    const inviteeName = getString(payload, "name");
    const inviteePhone = getString(payload, "text_reminder_number");
    const calendlyInviteeUri = getString(payload, "uri");
    const scheduledEvent = payload.scheduled_event;
    const calendlyEventUri = getString(scheduledEvent, "uri");
    const eventTypeUri = getString(scheduledEvent, "event_type");
    const scheduledAt = parseTimestamp(scheduledEvent.start_time);
    const endTime = parseTimestamp(scheduledEvent.end_time);

    console.log(
      `[Pipeline:invitee.created] Extracted fields | email=${inviteeEmail} name=${inviteeName} phone=${inviteePhone ? "provided" : "none"} calendlyEventUri=${calendlyEventUri} eventTypeUri=${eventTypeUri} scheduledAt=${scheduledAt} endTime=${endTime}`,
    );

    if (
      !inviteeEmail ||
      !calendlyInviteeUri ||
      !calendlyEventUri ||
      scheduledAt === undefined ||
      endTime === undefined
    ) {
      throw new Error("[Pipeline] Missing required fields in invitee.created payload");
    }

    const existingMeeting = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", calendlyEventUri),
      )
      .unique();
    if (existingMeeting) {
      console.log(
        `[Pipeline:invitee.created] Duplicate detected: meeting ${existingMeeting._id} already exists for eventUri=${calendlyEventUri}`,
      );
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }
    console.log(`[Pipeline:invitee.created] No duplicate meeting found, proceeding`);

    const now = Date.now();
    const durationMinutes = Math.max(1, Math.round((endTime - scheduledAt) / 60000));

    let lead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", inviteeEmail),
      )
      .unique();

    const latestCustomFields = extractQuestionsAndAnswers(payload.questions_and_answers);

    const utmParams = extractUtmParams(payload.tracking);
    console.log(`[Pipeline:invitee.created] UTM extraction | hasUtm=${!!utmParams} source=${utmParams?.utm_source ?? "none"} medium=${utmParams?.utm_medium ?? "none"} campaign=${utmParams?.utm_campaign ?? "none"}`);

    if (!lead) {
      const leadId = await ctx.db.insert("leads", {
        tenantId,
        email: inviteeEmail,
        fullName: inviteeName,
        phone: inviteePhone,
        customFields: latestCustomFields,
        firstSeenAt: now,
        updatedAt: now,
      });
      lead = (await ctx.db.get(leadId))!;
      console.log(`[Pipeline:invitee.created] Lead created | leadId=${leadId}`);
    } else {
      console.log(`[Pipeline:invitee.created] Lead updated | leadId=${lead._id}`);
      await ctx.db.patch(lead._id, {
        fullName: inviteeName || lead.fullName,
        phone: inviteePhone || lead.phone,
        customFields: mergeCustomFields(lead.customFields, latestCustomFields),
        updatedAt: now,
      });
    }

    const eventMemberships = Array.isArray(scheduledEvent.event_memberships)
      ? scheduledEvent.event_memberships
      : [];
    const primaryMembership = eventMemberships.find(isRecord);
    const hostUserUri = primaryMembership ? getString(primaryMembership, "user") : undefined;
    const hostCalendlyEmail = primaryMembership ? getString(primaryMembership, "user_email") : undefined;
    const hostCalendlyName = primaryMembership ? getString(primaryMembership, "user_name") : undefined;
    const assignedCloserId = await resolveAssignedCloserId(ctx, tenantId, hostUserUri);
    console.log(
      `[Pipeline:invitee.created] Assigned closer resolved | closerId=${assignedCloserId ?? "none"} hostEmail=${hostCalendlyEmail ?? "none"}`,
    );

    let eventTypeConfigId: Id<"eventTypeConfigs"> | undefined;
    if (eventTypeUri) {
      // Use .take + canonical row (oldest createdAt) instead of .unique() so a rare
      // double-insert race does not crash the pipeline with a uniqueness error.
      const configCandidates = await ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri),
        )
        .take(8);
      const existingConfig =
        configCandidates.length === 0
          ? null
          : configCandidates.reduce((best, row) =>
              row.createdAt < best.createdAt ? row : best,
            );

      if (configCandidates.length > 1) {
        console.warn(
          `[Pipeline:invitee.created] Multiple eventTypeConfigs for same URI (${configCandidates.length}); using canonical configId=${existingConfig!._id}`,
        );
      }

      if (existingConfig) {
        eventTypeConfigId = existingConfig._id;
        console.log(
          `[Pipeline:invitee.created] Event type config found | configId=${eventTypeConfigId}`,
        );
      } else {
        // Auto-create config on first booking for this event type.
        // Uses scheduled_event.name from the Calendly payload as the display name.
        const eventDisplayName =
          getString(scheduledEvent, "name") ?? "Calendly Meeting";
        const initialKeys = latestCustomFields
          ? Object.keys(latestCustomFields)
          : undefined;

        eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
          tenantId,
          calendlyEventTypeUri: eventTypeUri,
          displayName: eventDisplayName,
          createdAt: now,
          knownCustomFieldKeys:
            initialKeys && initialKeys.length > 0 ? initialKeys : undefined,
        });
        console.log(
          `[Pipeline:invitee.created] Event type config auto-created | configId=${eventTypeConfigId} displayName="${eventDisplayName}" initialKeys=${initialKeys ? JSON.stringify(initialKeys) : "none"}`,
        );
      }
    }

    let existingFollowUp: Doc<"opportunities"> | null = null;
    const followUpCandidates = ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", lead._id),
      )
      .order("desc");
    for await (const opportunity of followUpCandidates) {
      if (opportunity.status === "follow_up_scheduled") {
        existingFollowUp = opportunity;
        break;
      }
    }

    if (existingFollowUp) {
      console.log(
        `[Pipeline:invitee.created] Follow-up opportunity detected | opportunityId=${existingFollowUp._id}`,
      );
    } else {
      console.log(`[Pipeline:invitee.created] No follow-up opportunity found, creating new`);
    }

    let opportunityId: Id<"opportunities">;
    if (existingFollowUp) {
      if (!validateTransition(existingFollowUp.status, "scheduled")) {
        throw new Error("[Pipeline] Invalid follow-up opportunity transition");
      }

      opportunityId = existingFollowUp._id;
      await ctx.db.patch(opportunityId, {
        status: "scheduled",
        calendlyEventUri,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId:
          eventTypeConfigId ?? existingFollowUp.eventTypeConfigId ?? undefined,
        updatedAt: now,
        // NOTE: utmParams intentionally NOT included here.
        // The opportunity preserves attribution from its original creation.
        // The new meeting stores its own UTMs independently.
      });
      console.log(
        `[Pipeline:invitee.created] Follow-up opportunity reused | opportunityId=${opportunityId} status=follow_up_scheduled->scheduled`,
      );

      await ctx.runMutation(
        internal.closer.followUpMutations.markFollowUpBooked,
        {
          opportunityId,
          calendlyEventUri,
        },
      );
    } else {
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId,
        hostCalendlyUserUri: hostUserUri,
        hostCalendlyEmail,
        hostCalendlyName,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: now,
        updatedAt: now,
        utmParams,
      });
      console.log(
        `[Pipeline:invitee.created] New opportunity created | opportunityId=${opportunityId}`,
      );
    }

    const meetingLocation = extractMeetingLocation(scheduledEvent.location);
    const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");

    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      calendlyEventUri,
      calendlyInviteeUri,
      zoomJoinUrl: meetingLocation.zoomJoinUrl,
      meetingJoinUrl: meetingLocation.meetingJoinUrl,
      meetingLocationType: meetingLocation.meetingLocationType,
      scheduledAt,
      durationMinutes,
      status: "scheduled",
      notes: meetingNotes,
      leadName: lead.fullName ?? lead.email, // Denormalize for query efficiency
      createdAt: now,
      utmParams,
    });
    console.log(
      `[Pipeline:invitee.created] Meeting created | meetingId=${meetingId} durationMinutes=${durationMinutes}`,
    );

    // Update denormalized meeting refs on opportunity for efficient queries
    // (see @plans/caching/caching.md)
    await updateOpportunityMeetingRefs(ctx, opportunityId);
    console.log(`[Pipeline:invitee.created] Updated opportunity meeting refs | opportunityId=${opportunityId}`);

    // === Feature F: Auto-discover custom field keys ===
    // If this booking had questions_and_answers AND we have an eventTypeConfig,
    // ensure the config's knownCustomFieldKeys includes all question texts from this booking.
    // This populates the dropdown options in Settings > Field Mappings.
    if (latestCustomFields && eventTypeConfigId) {
      const incomingKeys = Object.keys(latestCustomFields);
      if (incomingKeys.length > 0) {
        const config = await ctx.db.get(eventTypeConfigId);
        if (config) {
          const existingKeys = config.knownCustomFieldKeys ?? [];
          const existingSet = new Set(existingKeys);
          const newKeys = incomingKeys.filter((k) => !existingSet.has(k));

          if (newKeys.length > 0) {
            const updatedKeys = [...existingKeys, ...newKeys];
            await ctx.db.patch(eventTypeConfigId, {
              knownCustomFieldKeys: updatedKeys,
            });
            console.log(
              `[Pipeline:invitee.created] [Feature F] Auto-discovered ${newKeys.length} new custom field key(s) | configId=${eventTypeConfigId} newKeys=${JSON.stringify(newKeys)} totalKeys=${updatedKeys.length}`,
            );
          }
        }
      }
    }
    // === End Feature F ===

    await ctx.db.patch(rawEventId, { processed: true });
    console.log(`[Pipeline:invitee.created] Marked processed | rawEventId=${rawEventId}`);
  },
});
