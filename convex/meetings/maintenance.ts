/**
 * Meeting link maintenance operations.
 *
 * Includes dry-run audit and production backfill for meeting link normalization.
 * See @plans/v0.5/meeting-link-normalization/meeting-link-normalization-design.md
 */

import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { extractMeetingLocation } from "../lib/meetingLocation";

interface BackfillResult {
  patched: number;
  recoverable: number;
  malformed: number;
  dryRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Audit and optionally backfill meeting links for a tenant.
 *
 * Reads raw invitee.created webhook events, extracts normalized meeting locations,
 * and patches meetings that are missing meetingJoinUrl but have a recoverable URL
 * in the raw payload.
 *
 * Safe to run in dry-run mode first to inspect what would be patched.
 *
 * @param tenantId - The tenant to backfill
 * @param dryRun - If true, count changes but do not apply patches
 * @returns Counts of patched, recoverable, and malformed meetings
 */
export const backfillMeetingLinks = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { tenantId, dryRun }): Promise<BackfillResult> => {
    console.log(`[Meetings:Backfill] Starting | tenantId=${tenantId} dryRun=${dryRun}`);

    const locationByScheduledEventUri = new Map<
      string,
      ReturnType<typeof extractMeetingLocation>
    >();
    let rawEventCount = 0;

    for await (const rawEvent of ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) =>
        q.eq("tenantId", tenantId).eq("eventType", "invitee.created"),
      )
      .order("desc")) {
      rawEventCount += 1;
      try {
        const envelope = JSON.parse(rawEvent.payload) as unknown;
        const payload = isRecord(envelope) ? envelope.payload : undefined;
        if (!isRecord(payload) || !isRecord(payload.scheduled_event)) {
          continue;
        }

        const scheduledEventUri = getString(payload.scheduled_event, "uri");
        if (!scheduledEventUri || locationByScheduledEventUri.has(scheduledEventUri)) {
          continue;
        }

        const normalized = extractMeetingLocation(payload.scheduled_event.location);
        locationByScheduledEventUri.set(scheduledEventUri, normalized);
      } catch (err) {
        console.error(
          `[Meetings:Backfill] Failed to parse raw event | rawEventId=${rawEvent._id} error=${err}`,
        );
      }
    }

    console.log(
      `[Meetings:Backfill] Built location map | rawEvents=${rawEventCount} uniqueScheduledEvents=${locationByScheduledEventUri.size}`,
    );

    let meetingCount = 0;
    let patched = 0;
    let recoverable = 0;
    let malformed = 0;

    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId))
      .order("desc")) {
      meetingCount += 1;

      if (meeting.meetingJoinUrl) {
        continue;
      }

      const normalized = locationByScheduledEventUri.get(meeting.calendlyEventUri);
      if (!normalized) {
        continue;
      }

      if (normalized.meetingJoinUrl) {
        recoverable += 1;
        if (!dryRun) {
          await ctx.db.patch(meeting._id, {
            meetingJoinUrl: normalized.meetingJoinUrl,
            meetingLocationType: normalized.meetingLocationType,
            ...(normalized.zoomJoinUrl && !meeting.zoomJoinUrl
              ? { zoomJoinUrl: normalized.zoomJoinUrl }
              : {}),
          });
        }
        patched += 1;
        continue;
      }

      if (normalized.meetingLocationType) {
        malformed += 1;
      }
    }

    console.log(
      `[Meetings:Backfill] Completed | meetings=${meetingCount} patched=${patched} recoverable=${recoverable} malformed=${malformed} dryRun=${dryRun}`,
    );

    return { patched, recoverable, malformed, dryRun: !!dryRun };
  },
});
