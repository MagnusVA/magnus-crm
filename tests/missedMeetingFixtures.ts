import { vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bookingHarness } from "./bookingHarness";

// Fixtures for the missed-meeting booking rules (phase 5, §4.3 of the deal
// status plan): one person's Calendly webhooks delivered through the real
// pipeline, and the deal, meeting and task rows the tests read back.

const MINUTE = 60_000;
const CLOSER_URI = "https://api.calendly.com/users/closer";
const EVENT_TYPE_URI = "https://api.calendly.com/event_types/test";
const PERSONAL_EVENT_TYPE = "https://calendly.com/closer/strategy";

export type InviteeEventType =
  | "invitee.created"
  | "invitee.canceled"
  | "invitee_no_show.created";

const scheduledEventUri = (key: string) =>
  `https://api.calendly.com/scheduled_events/${key}`;

/** The invitee URI of the booking `key`. */
export const inviteeUri = (key: string) =>
  `${scheduledEventUri(key)}/invitees/person`;

export type Booking = {
  key: string;
  /** The call's start time, ISO. */
  start: string;
  /** The invitee this booking replaces in a Calendly reschedule. */
  oldInvitee?: string;
  tracking?: Record<string, string>;
  /** Set on a cancel payload. `rescheduledTo` makes it a reschedule's cancel. */
  canceled?: { rescheduledTo?: string };
};

/** A Calendly invitee payload with the fields the pipeline reads. */
export function inviteePayload(booking: Booking) {
  const start = Date.parse(booking.start);
  const canceled = booking.canceled;
  return {
    uri: inviteeUri(booking.key),
    event: scheduledEventUri(booking.key),
    email: "lead@example.com",
    name: "Test Lead",
    status: canceled ? "canceled" : "active",
    rescheduled: Boolean(canceled?.rescheduledTo),
    new_invitee: canceled?.rescheduledTo ?? null,
    old_invitee: booking.oldInvitee ?? null,
    ...(canceled
      ? {
          cancellation: {
            canceled_by: "Test Lead",
            canceler_type: "invitee",
            reason: "Schedule conflict",
          },
        }
      : {}),
    ...(booking.tracking ? { tracking: booking.tracking } : {}),
    scheduled_event: {
      uri: scheduledEventUri(booking.key),
      event_type: EVENT_TYPE_URI,
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 30 * MINUTE).toISOString(),
      event_memberships: [
        { user: CLOSER_URI, user_email: "closer@example.com", user_name: "Closer" },
      ],
    },
  };
}

/** Tracking of a booking through a link the CRM sent for `opportunityId`. */
export function crmLinkTracking(
  medium: "follow_up" | "noshow_resched",
  opportunityId: Id<"opportunities">,
  content: string,
) {
  return {
    utm_source: "ptdom",
    utm_medium: medium,
    utm_campaign: opportunityId,
    utm_content: content,
  };
}

/** ISO time `minutes` after the test clock. */
export function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * MINUTE).toISOString();
}

export async function missedMeetingHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    await ctx.db.patch("users", closer!._id, {
      personalEventTypeUri: PERSONAL_EVENT_TYPE,
    });
  });

  /** Moves the test clock to `at`, never backwards: Workpool timers advance it. */
  function clockAt(at: string) {
    vi.setSystemTime(Math.max(Date.now(), Date.parse(at)));
  }

  /** Delivers one webhook that Calendly created at `at`. */
  async function deliver(eventType: InviteeEventType, booking: Booking, at: string) {
    const payload = inviteePayload(booking);
    clockAt(at);
    vi.setSystemTime(Date.now() + 1_000);
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ created_at: at, event: eventType, payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  async function receipt(eventType: InviteeEventType, key: string) {
    const rows = await t.run((ctx) =>
      ctx.db
        .query("webhookDeliveries")
        .withIndex("by_tenantId_and_inviteeUri_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("inviteeUri", inviteeUri(key)),
        )
        .take(10),
    );
    const row = rows.find((r) => r.eventType === eventType);
    if (!row) throw new Error(`No ${eventType} receipt for ${key}`);
    return row;
  }

  /** Books `booking` and returns the deal and meeting it applied to. */
  async function book(booking: Booking, at: string) {
    await deliver("invitee.created", booking, at);
    const row = await receipt("invitee.created", booking.key);
    if (row.status !== "applied" || !row.opportunityId || !row.meetingId)
      throw new Error(`Booking ${booking.key} was ${row.status}: ${row.reason}`);
    return { opportunityId: row.opportunityId, meetingId: row.meetingId };
  }

  async function meeting(key: string) {
    return await t.run((ctx) =>
      ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventUri", scheduledEventUri(key)),
        )
        .unique(),
    );
  }

  async function deal(opportunityId: Id<"opportunities">) {
    return await t.run((ctx) => ctx.db.get("opportunities", opportunityId));
  }

  async function dealCount() {
    return (await t.run((ctx) => ctx.db.query("opportunities").take(10))).length;
  }

  async function followUps(opportunityId: Id<"opportunities">) {
    return await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) =>
          q.eq("opportunityId", opportunityId),
        )
        .take(10),
    );
  }

  /** What a new deal's creation writes besides the row itself. */
  async function creationSideEffects(opportunityId: Id<"opportunities">) {
    return await t.run(async (ctx) => {
      const events = await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("entityType", "opportunity")
            .eq("entityId", opportunityId),
        )
        .take(20);
      const credit = await ctx.db
        .query("dealAttributions")
        .withIndex("by_tenantId_and_opportunityId_and_role", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("opportunityId", opportunityId)
            .eq("role", "closer"),
        )
        .take(10);
      const stats = await ctx.db
        .query("tenantStats")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .unique();
      const opportunity = await ctx.db.get("opportunities", opportunityId);
      return {
        created: events.some((e) => e.eventType === "opportunity.created"),
        closerCredit: credit.length,
        firstTouch: opportunity?.firstTouch !== undefined,
        totalOpportunities: stats?.totalOpportunities,
      };
    });
  }

  /** The closer's actions on the deal, each at the test clock. */
  const closerActions = {
    /** A follow-up scheduling link the closer copied but never confirmed. */
    async unconfirmedSchedulingLink(opportunityId: Id<"opportunities">) {
      const { followUpId } = await harness.closer.mutation(
        api.closer.followUpMutations.createSchedulingLinkFollowUp,
        { opportunityId },
      );
      return followUpId;
    },
    async rescheduleLink(
      opportunityId: Id<"opportunities">,
      meetingId: Id<"meetings">,
    ) {
      const { followUpId } = await harness.closer.mutation(
        api.closer.noShowActions.createNoShowRescheduleLink,
        { opportunityId, meetingId },
      );
      return followUpId;
    },
  };

  return {
    ...harness,
    clockAt,
    deliver,
    receipt,
    book,
    meeting,
    deal,
    dealCount,
    followUps,
    creationSideEffects,
    closerActions,
  };
}

export type MissedMeetingHarness = Awaited<ReturnType<typeof missedMeetingHarness>>;
