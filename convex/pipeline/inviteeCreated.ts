import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";

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
  const tenant = await ctx.db.get(tenantId);

  if (!hostUserUri) {
    return tenant?.tenantOwnerId;
  }

  const directUser = await ctx.db
    .query("users")
    .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyUserUri", hostUserUri),
    )
    .unique();
  if (directUser?.role === "closer") {
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
      return matchedUser._id;
    }
  }

  console.warn(
    `[Pipeline] Unmatched Calendly host URI: ${hostUserUri}. Falling back to tenant owner.`,
  );
  return tenant?.tenantOwnerId;
}

export const process = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    payload: v.any(),
    rawEventId: v.id("rawWebhookEvents"),
  },
  handler: async (ctx, { tenantId, payload, rawEventId }) => {
    const rawEvent = await ctx.db.get(rawEventId);
    if (!rawEvent || rawEvent.processed) {
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
      await ctx.db.patch(rawEventId, { processed: true });
      return;
    }

    const now = Date.now();
    const durationMinutes = Math.max(1, Math.round((endTime - scheduledAt) / 60000));

    let lead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", inviteeEmail),
      )
      .unique();

    const latestCustomFields = extractQuestionsAndAnswers(payload.questions_and_answers);
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
    } else {
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
    const assignedCloserId = await resolveAssignedCloserId(ctx, tenantId, hostUserUri);

    let eventTypeConfigId: Id<"eventTypeConfigs"> | undefined;
    if (eventTypeUri) {
      const config = await ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventTypeUri),
        )
        .unique();
      eventTypeConfigId = config?._id;
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

    let opportunityId: Id<"opportunities">;
    if (existingFollowUp) {
      if (!validateTransition(existingFollowUp.status, "scheduled")) {
        throw new Error("[Pipeline] Invalid follow-up opportunity transition");
      }

      opportunityId = existingFollowUp._id;
      await ctx.db.patch(opportunityId, {
        status: "scheduled",
        calendlyEventUri,
        assignedCloserId:
          assignedCloserId ?? existingFollowUp.assignedCloserId ?? undefined,
        eventTypeConfigId:
          eventTypeConfigId ?? existingFollowUp.eventTypeConfigId ?? undefined,
        updatedAt: now,
      });
    } else {
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId: lead._id,
        assignedCloserId,
        eventTypeConfigId,
        status: "scheduled",
        calendlyEventUri,
        createdAt: now,
        updatedAt: now,
      });
    }

    const zoomJoinUrl =
      isRecord(scheduledEvent.location)
        ? getString(scheduledEvent.location, "join_url")
        : undefined;
    const meetingNotes = getString(scheduledEvent, "meeting_notes_plain");

    await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      calendlyEventUri,
      calendlyInviteeUri,
      zoomJoinUrl,
      scheduledAt,
      durationMinutes,
      status: "scheduled",
      notes: meetingNotes,
      createdAt: now,
    });

    await ctx.db.patch(rawEventId, { processed: true });
  },
});
