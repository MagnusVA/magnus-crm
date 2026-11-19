import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingHarness, bookingPayload, qualifiedLifecycle, testLeadGenTeam } from "../../tests/bookingHarness";
import { api, internal } from "../_generated/api";
import type { UtmParams } from "../lib/utmParams";
import { insertOpportunityAggregate } from "../reporting/writeHooks";

const FIRST_BOOKED_AT = "2026-10-01T09:00:00Z";
const REBOOKED_AT = "2026-10-01T10:00:00Z";
const LINK_CODE = "coaching";
const DM_TRACKING = { utm_source: "dm-team", utm_medium: "dm-setter", utm_campaign: "october" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

type Calendar = "flagged" | "ordinary" | "fixed" | "flagged_fixed";
const CALENDAR_KINDS = ["one-on-one", "round_robin"] as const;
type CalendarKind = (typeof CALENDAR_KINDS)[number];

async function setup(calendar: Calendar = "flagged", kind: CalendarKind = "one-on-one") {
  const { t, tenantId, admin } = await bookingHarness({ transactionLimits: true });
  const programId = await admin.mutation(api.tenantPrograms.mutations.upsertProgram, {
    name: "Coaching", linkCode: LINK_CODE,
  });
  const archivedId = await admin.mutation(api.tenantPrograms.mutations.upsertProgram, {
    name: "Archived Program", linkCode: "archived",
  });
  const fixedProgramId = await admin.mutation(api.tenantPrograms.mutations.upsertProgram, {
    name: "Fixed Program",
  });
  await admin.mutation(api.tenantPrograms.mutations.archiveProgram, { programId: archivedId });
  const { eventTypeConfigId, closerId } = await t.run(async (ctx) => {
    const closer = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique();
    if (!closer?.calendlyUserUri) throw new Error("Missing fixture closer");
    await ctx.db.patch("tenantPrograms", programId, { retiredLinkCodes: ["retired"] });
    const flagged = calendar === "flagged" || calendar === "flagged_fixed";
    const fixed = calendar === "fixed" || calendar === "flagged_fixed";
    const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
      tenantId,
      calendlyEventTypeUri: bookingPayload("fixture").scheduled_event.event_type,
      displayName: "Personal sales call",
      calendlyOwnerUri: closer.calendlyUserUri,
      calendlyKind: "solo",
      ...(kind === "round_robin" ? {
        calendlyOwnerUri: "https://api.calendly.com/users/booking-admin",
        calendlyPoolingType: "round_robin",
        calendlySoleHostUri: closer.calendlyUserUri,
      } : {}),
      bookingBaseUrl: "https://calendly.com/closer/sales",
      programFromLinkAt: flagged ? 0 : undefined,
      bookingProgramId: fixed ? fixedProgramId : undefined,
      bookingProgramName: fixed ? "Fixed Program" : undefined,
      bookingProgramMappingStatus: fixed ? "mapped" : "unmapped",
      createdAt: 0,
    });
    return { eventTypeConfigId, closerId: closer._id };
  });
  return { t, tenantId, admin, programId, fixedProgramId, eventTypeConfigId, closerId };
}

type Harness = Awaited<ReturnType<typeof setup>>;
type Payload = Omit<ReturnType<typeof bookingPayload>, "scheduled_event"> & {
  scheduled_event: Omit<ReturnType<typeof bookingPayload>["scheduled_event"], "event_type"> & {
    event_type?: string;
  };
  tracking?: UtmParams;
  old_invitee?: string;
};

async function deliver(h: Harness, payload: Payload, createdAt = FIRST_BOOKED_AT) {
  await h.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: h.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: createdAt, payload }),
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const { page } = await h.admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  return page.find((row) => row.occurredAt === Date.parse(createdAt));
}

async function book(h: Harness, payload: Payload, createdAt?: string) {
  const receipt = await deliver(h, payload, createdAt);
  expect(receipt).toMatchObject({ status: "applied" });
  if (!receipt?.meetingId || !receipt.opportunityId) throw new Error("Missing booking receipt IDs");
  const { meetingId, opportunityId } = receipt;
  return await h.t.run(async (ctx) => {
    const meeting = await ctx.db.get("meetings", meetingId);
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!meeting || !opportunity) throw new Error("Missing booking rows");
    return { meeting, opportunity };
  });
}

describe("booking on a closer's personal calendar", () => {
  it.each(CALENDAR_KINDS)("assigns the host and maps the program alongside DM attribution for %s", async (kind) => {
    const h = await setup("flagged", kind);
    const teamId = await h.t.run((ctx) => testLeadGenTeam(ctx, h.tenantId, DM_TRACKING.utm_source));
    await h.admin.mutation(api.attribution.dmClosers.createDmCloser, {
      teamId, displayName: "DM Setter", utmMedium: DM_TRACKING.utm_medium,
    });

    const { meeting, opportunity } = await book(h, {
      ...bookingPayload("closer-link"),
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    });

    expect(meeting).toMatchObject({
      assignedCloserId: h.closerId,
      bookingProgramId: h.programId,
      bookingProgramName: "Coaching",
      bookingProgramMappingStatus: "mapped",
      attributionResolution: "mapped",
    });
    expect(opportunity).toMatchObject({
      firstMeetingId: meeting._id,
      firstBookingProgramId: h.programId,
      firstBookingProgramName: "Coaching",
      firstBookingProgramMappingStatus: "mapped",
    });
  });

  it.each([
    ["missing code", undefined],
    ["unknown code", "unknown"],
    ["archived program", "archived"],
    ["retired code", "retired"],
    ["10 KB of garbage", "?".repeat(10 * 1024)],
    ["a valid prefix before 10 KB of garbage", LINK_CODE + " ".repeat(64) + "?".repeat(10 * 1024)],
  ])("applies the booking as unmapped with %s", async (_scenario, code) => {
    const h = await setup();
    const { meeting, opportunity } = await book(h, {
      ...bookingPayload("unmapped"),
      tracking: { ...DM_TRACKING, utm_content: code },
    });

    expect(meeting.bookingProgramMappingStatus).toBe("unmapped");
    expect(meeting.bookingProgramId).toBeUndefined();
    expect(opportunity.firstMeetingId).toBe(meeting._id);
    expect(opportunity.firstBookingProgramMappingStatus).toBe("unmapped");
    expect(opportunity.firstBookingProgramId).toBeUndefined();
  });

  it("leaves the program unmapped on a calendar without the flag", async () => {
    const h = await setup("ordinary");
    const { meeting, opportunity } = await book(h, {
      ...bookingPayload("ordinary"),
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    });

    expect(meeting.bookingProgramMappingStatus).toBe("unmapped");
    expect(meeting.bookingProgramId).toBeUndefined();
    expect(opportunity.firstBookingProgramMappingStatus).toBe("unmapped");
    expect(opportunity.firstBookingProgramId).toBeUndefined();
  });

  it.each(CALENDAR_KINDS)("uses a fixed program ahead of the link code for %s", async (kind) => {
    const h = await setup("flagged_fixed", kind);
    const { meeting, opportunity } = await book(h, {
      ...bookingPayload("fixed"),
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    });

    expect(meeting).toMatchObject({
      bookingProgramId: h.fixedProgramId,
      bookingProgramName: "Fixed Program",
      bookingProgramMappingStatus: "mapped",
    });
    expect(opportunity.firstBookingProgramId).toBe(h.fixedProgramId);
  });

  it("books the targeted CRM follow-up on a flagged calendar and leaves the program unmapped", async () => {
    const h = await setup();
    const { opportunityId, followUpId } = await h.t.run(async (ctx) => {
      const at = Date.parse(FIRST_BOOKED_AT) - 60_000;
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(at),
        tenantId: h.tenantId,
        email: "lead@example.com",
        status: "active",
        firstSeenAt: at,
        updatedAt: at,
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        tenantId: h.tenantId,
        leadId,
        stage: "follow_up",
        outcome: "open",
        source: "calendly",
        assignedCloserId: h.closerId,
        eventTypeConfigId: h.eventTypeConfigId,
        createdAt: at,
        updatedAt: at,
      });
      await insertOpportunityAggregate(ctx, opportunityId);
      const followUpId = await ctx.db.insert("followUps", {
        tenantId: h.tenantId,
        opportunityId,
        leadId,
        closerId: h.closerId,
        type: "scheduling_link",
        reason: "closer_initiated",
        status: "pending",
        createdAt: at,
      });
      return { opportunityId, followUpId };
    });

    const { meeting, opportunity } = await book(h, {
      ...bookingPayload("follow-up-link"),
      tracking: {
        utm_source: "ptdom",
        utm_medium: "follow_up",
        utm_campaign: opportunityId,
        utm_content: followUpId,
      },
    });

    expect(opportunity).toMatchObject({ _id: opportunityId, stage: "booked" });
    expect(meeting).toMatchObject({
      attributionResolution: "internal",
      bookingProgramMappingStatus: "unmapped",
    });
    expect(meeting.bookingProgramId).toBeUndefined();
    expect(opportunity.firstMeetingId).toBeUndefined();
    expect(opportunity.firstBookingProgramId).toBeUndefined();
    expect(await h.t.run((ctx) => ctx.db.get("followUps", followUpId))).toMatchObject({ status: "booked" });
  });

  it.each(CALENDAR_KINDS)("skips a valid code on a CRM booking for %s on the ordinary insert path", async (kind) => {
    const h = await setup("flagged", kind);
    const { meeting, opportunity } = await book(h, {
      ...bookingPayload("internal-tracking"),
      tracking: { utm_source: "ptdom", utm_content: LINK_CODE },
    });

    expect(meeting.attributionResolution).toBe("internal");
    expect(meeting.bookingProgramMappingStatus).toBe("unmapped");
    expect(meeting.bookingProgramId).toBeUndefined();
    expect(opportunity.firstBookingProgramId).toBeUndefined();
  });

  it("inherits the replaced meeting's program when Calendly reschedules without tracking", async () => {
    const h = await setup();
    const original = bookingPayload("original");
    const before = await book(h, {
      ...original,
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    });
    const after = await book(h, {
      ...bookingPayload("replacement"),
      old_invitee: original.uri,
    }, REBOOKED_AT);

    expect(after.opportunity._id).toBe(before.opportunity._id);
    expect(after.opportunity.firstMeetingId).toBe(before.meeting._id);
    expect(after.opportunity.firstBookingProgramId).toBe(h.programId);
    expect(after.meeting).toMatchObject({
      rescheduledFromMeetingId: before.meeting._id,
      bookingProgramId: h.programId,
      bookingProgramName: "Coaching",
      bookingProgramMappingStatus: "mapped",
    });
  });

  it("keeps a closer-link program on a reschedule with neither event_type nor tracking", async () => {
    const h = await setup();
    const original = bookingPayload("original");
    const before = await book(h, {
      ...original,
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    });
    const replacement = bookingPayload("replacement");
    const after = await book(h, {
      ...replacement,
      scheduled_event: { ...replacement.scheduled_event, event_type: undefined },
      old_invitee: original.uri,
    }, REBOOKED_AT);

    expect(after.meeting).toMatchObject({
      rescheduledFromMeetingId: before.meeting._id,
      bookingProgramId: h.programId,
      bookingProgramMappingStatus: "mapped",
    });
  });

  it("keeps a closer-link program on a reschedule after the calendar is set aside", async () => {
    const h = await setup();
    const original = bookingPayload("original");
    const before = await book(h, {
      ...original,
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    });
    await h.t.run((ctx) => ctx.db.patch("eventTypeConfigs", h.eventTypeConfigId, { notSalesCallAt: 1 }));
    const after = await book(h, {
      ...bookingPayload("replacement"),
      old_invitee: original.uri,
      tracking: { ...DM_TRACKING, utm_content: "archived" },
    }, REBOOKED_AT);

    expect(after.meeting).toMatchObject({
      rescheduledFromMeetingId: before.meeting._id,
      bookingProgramId: h.programId,
      bookingProgramMappingStatus: "mapped",
    });
  });

  it("keeps the deal calendar's fixed program on a reschedule without event_type", async () => {
    const h = await setup("fixed");
    const original = bookingPayload("original");
    const before = await book(h, original);
    const replacement = bookingPayload("replacement");
    const after = await book(h, {
      ...replacement,
      scheduled_event: { ...replacement.scheduled_event, event_type: undefined },
      old_invitee: original.uri,
    }, REBOOKED_AT);

    expect(after.opportunity).toMatchObject({
      _id: before.opportunity._id,
      eventTypeConfigId: h.eventTypeConfigId,
      firstBookingProgramId: h.fixedProgramId,
    });
    expect(after.meeting).toMatchObject({
      rescheduledFromMeetingId: before.meeting._id,
      bookingProgramId: h.fixedProgramId,
      bookingProgramName: "Fixed Program",
      bookingProgramMappingStatus: "mapped",
    });
  });

  it.each<{ calendar: Calendar; status: string; reason: string }>([
    { calendar: "flagged", status: "blocked", reason: "host_not_linked" },
    { calendar: "ordinary", status: "ignored", reason: "unlinked_host_unmapped_event_type" },
  ])("marks an unlinked host's $calendar booking $status", async ({ calendar, status, reason }) => {
    const h = await setup(calendar);
    const payload = {
      ...bookingPayload("unlinked"),
      tracking: { ...DM_TRACKING, utm_content: LINK_CODE },
    };
    const membership = payload.scheduled_event.event_memberships[0];
    membership.user = "https://api.calendly.com/users/unlinked";
    membership.user_email = "unlinked@example.com";

    expect(await deliver(h, payload)).toMatchObject({ status, reason });
    expect(await h.t.run((ctx) => ctx.db.query("meetings").take(1))).toEqual([]);
  });
});
