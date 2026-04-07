import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function resolveAssignedCloserId(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  hostUserUri: string | undefined,
): Promise<Id<"users"> | undefined> {
  if (!hostUserUri) {
    return undefined;
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

  return undefined;
}

export const repairAssignmentsFromCalendlyHosts = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Opportunities:Maintenance] repairAssignmentsFromCalendlyHosts start", {
      tenantId,
    });

    const hostByEventUri = new Map<
      string,
      {
        hostCalendlyUserUri?: string;
        hostCalendlyEmail?: string;
        hostCalendlyName?: string;
      }
    >();

    for await (const rawEvent of ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) =>
        q.eq("tenantId", tenantId).eq("eventType", "invitee.created"),
      )
      .order("desc")) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(rawEvent.payload);
      } catch {
        continue;
      }

      const payload = isRecord(envelope) ? envelope.payload : undefined;
      if (!isRecord(payload) || !isRecord(payload.scheduled_event)) {
        continue;
      }

      const scheduledEventUri = getString(payload.scheduled_event, "uri");
      if (!scheduledEventUri || hostByEventUri.has(scheduledEventUri)) {
        continue;
      }

      const memberships = Array.isArray(payload.scheduled_event.event_memberships)
        ? payload.scheduled_event.event_memberships
        : [];
      const primaryMembership = memberships.find(isRecord);

      hostByEventUri.set(scheduledEventUri, {
        hostCalendlyUserUri: primaryMembership
          ? getString(primaryMembership, "user")
          : undefined,
        hostCalendlyEmail: primaryMembership
          ? getString(primaryMembership, "user_email")
          : undefined,
        hostCalendlyName: primaryMembership
          ? getString(primaryMembership, "user_name")
          : undefined,
      });
    }

    let scanned = 0;
    let patched = 0;

    for await (const opportunity of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      scanned += 1;

      const hostDetails = opportunity.calendlyEventUri
        ? hostByEventUri.get(opportunity.calendlyEventUri)
        : undefined;
      const assignedCloserId = await resolveAssignedCloserId(
        ctx,
        tenantId,
        hostDetails?.hostCalendlyUserUri,
      );

      const currentAssignedUser = opportunity.assignedCloserId
        ? await ctx.db.get(opportunity.assignedCloserId)
        : null;
      const hasInvalidAssignedCloser =
        Boolean(opportunity.assignedCloserId) &&
        currentAssignedUser?.role !== "closer";

      if (!hostDetails && !hasInvalidAssignedCloser) {
        continue;
      }

      await ctx.db.patch(opportunity._id, {
        assignedCloserId,
        hostCalendlyUserUri: hostDetails?.hostCalendlyUserUri,
        hostCalendlyEmail: hostDetails?.hostCalendlyEmail,
        hostCalendlyName: hostDetails?.hostCalendlyName,
        updatedAt: Date.now(),
      });
      patched += 1;
    }

    console.log("[Opportunities:Maintenance] repairAssignmentsFromCalendlyHosts complete", {
      tenantId,
      scanned,
      patched,
      mappedHosts: hostByEventUri.size,
    });

    return { scanned, patched, mappedHosts: hostByEventUri.size };
  },
});
