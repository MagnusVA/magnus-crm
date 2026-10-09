import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";

afterEach(() => vi.useRealTimers());

it.each([
  "invitee.canceled",
  "invitee_no_show.created",
  "invitee_no_show.deleted",
])("blocks a different invitee's %s without changing the booked meeting", async (eventType) => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } = await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  const booked = bookingPayload("shared-event");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: booked.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload: booked }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const otherInvitee = { ...booked, uri: booked.uri.replace("/person", "/other") };
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: otherInvitee.uri,
    eventType,
    payload: JSON.stringify({ payload: otherInvitee }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const receipts = (await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  })).page;
  expect(receipts).toMatchObject([
    { status: "blocked", reason: "ambiguous_booking_identity" },
    { status: "applied" },
  ]);
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: receipts[1].meetingId!,
  });
  expect(detail.meeting.status).toBe("scheduled");
  expect(detail.opportunity.status).toBe("scheduled");
});

it("keeps a durable ignored outcome and deduplicates repeated delivery", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, convexTestModules);
  workpool.register(t, "webhookWorkpool");
  const tenantId = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Test",
      contactEmail: "admin@example.com",
      workosOrgId: "org_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_test",
      email: "admin@example.com",
      role: "tenant_admin",
      isActive: true,
    });
    return tenantId;
  });
  const delivery = {
    tenantId,
    calendlyEventUri: "https://api.calendly.com/event_types/test",
    eventType: "event_type.updated",
    payload: JSON.stringify({
      created_at: "2026-10-01T00:00:00Z",
      payload: {},
    }),
  };
  const id = await t.mutation(
    internal.webhooks.calendlyMutations.persistRawEvent,
    delivery,
  );
  expect(id).not.toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const admin = t.withIdentity({ subject: "user_test", org_id: "org_test" });
  const result = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.page).toMatchObject([
    { status: "ignored", reason: "unsupported_event_type" },
  ]);
  await t.mutation(internal.webhooks.cleanupMutations.deleteExpiredEvents, {
    cutoffTimestamp: Date.now() + 1,
  });
  expect(
    await t.mutation(
      internal.webhooks.calendlyMutations.persistRawEvent,
      delivery,
    ),
  ).toBeNull();
});

it("retains an early cancellation and applies it when the booking arrives", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("canceled-first");
  for (const eventType of ["invitee.canceled", "invitee.created"]) {
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({
        created_at:
          eventType === "invitee.created"
            ? "2026-10-01T09:00:00Z"
            : "2026-10-01T10:00:00Z",
        payload,
      }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    }),
  ).toMatchObject({ scheduled: 1, canceled: 1 });
  const receipts = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
  ).page;
  expect(receipts.every((r) => r.status === "applied")).toBe(true);
});

it("does not join different emails through a placeholder phone", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  for (const name of ["alice", "bob"]) {
    const payload = {
      ...bookingPayload(name, `${name}@example.com`),
      text_reminder_number: "+12345678910",
    };
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  const result = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.page.map((r) => r.status)).toEqual(["applied", "applied"]);
  expect(new Set(result.page.map((r) => r.leadId)).size).toBe(2);
});

it("holds conflicting identifiers for review without attaching another email", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  for (const name of ["alice", "bob"]) {
    const payload = {
      ...bookingPayload(name, `${name}@example.com`),
      text_reminder_number: "+17789559253",
    };
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  const result = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.page).toMatchObject([
    { status: "blocked", reason: "identity_conflict" },
    { status: "applied" },
  ]);
});

it("accepts Unicode and multiline question labels without dropping the booking", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  const payload = {
    ...bookingPayload("unicode"),
    questions_and_answers: [
      { question: "What’s your goal?\nTell us 🎯", answer: "Grow" },
      { question: "同じ", answer: "One" },
      { question: "同じ", answer: "Two" },
    ],
  };
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const result = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.page[0]).toMatchObject({ status: "applied" });
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: result.page[0].meetingId!,
  });
  expect(Object.values(detail.lead.customFields ?? {}).sort()).toEqual([
    "Grow",
    "One",
    "Two",
  ]);
  expect(Object.values(detail.lead.customFieldLabels ?? {})).toContain(
    "What’s your goal?\nTell us 🎯",
  );
});

it("recovers a reviewed host failure once and rejects reuse of its preview", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("unlinked");
  payload.scheduled_event.event_memberships[0].user =
    "https://api.calendly.com/users/new-host";
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const result = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(result.page[0]).toMatchObject({
    status: "blocked",
    reason: "host_not_linked",
  });
  const manifest = await admin.query(api.pipeline.recovery.preview, {
    deliveryIds: [result.page[0]._id],
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "host_new",
      email: "new@example.com",
      role: "closer",
      isActive: true,
      calendlyUserUri: "https://api.calendly.com/users/new-host",
    });
  });
  await admin.mutation(api.pipeline.recovery.retry, { manifest });
  await expect(
    admin.mutation(api.pipeline.recovery.retry, { manifest }),
  ).rejects.toThrow("Recovery preview is stale");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (
      await admin.query(api.pipeline.delivery.list, {
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page[0],
  ).toMatchObject({ status: "applied", generation: 2 });
});

it("blocks a booking hosted by an inactive closer", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  await t.run(async (ctx) => {
    const host = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("calendlyUserUri", "https://api.calendly.com/users/closer"),
      )
      .unique();
    if (!host) throw new Error("Fixture host missing");
    await ctx.db.patch("users", host._id, { isActive: false });
  });
  const payload = bookingPayload("inactive");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (
      await admin.query(api.pipeline.delivery.list, {
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page[0],
  ).toMatchObject({ status: "blocked", reason: "host_inactive" });
});

it("keeps no-show reversal ordered by provider time rather than delivery time", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("ordered");
  for (const [eventType, created_at] of [
    ["invitee_no_show.deleted", "2026-10-01T14:00:00Z"],
    ["invitee_no_show.created", "2026-10-01T13:00:00Z"],
    ["invitee.created", "2026-10-01T09:00:00Z"],
  ]) {
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ created_at, payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    }),
  ).toMatchObject({ scheduled: 1, noShows: 0 });
});

it("uses an explicit reschedule link and does not let the old cancellation cancel the new booking", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  const old = bookingPayload("old");
  const next = { ...bookingPayload("new"), old_invitee: old.uri };
  for (const [eventType, created_at, payload] of [
    ["invitee.created", "2026-10-01T09:00:00Z", old],
    ["invitee.created", "2026-10-01T10:00:00Z", next],
    ["invitee.canceled", "2026-10-01T10:00:00Z", old],
  ] as const) {
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ created_at, payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  const deliveries = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
  ).page;
  expect(deliveries.every((d) => d.status === "applied")).toBe(true);
  expect(new Set(deliveries.map((d) => d.opportunityId)).size).toBe(1);
  const newestBooking = deliveries.find(
    (d) =>
      d.eventType === "invitee.created" &&
      d.occurredAt === Date.parse("2026-10-01T10:00:00Z"),
  );
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: newestBooking!.meetingId!,
  });
  expect(detail.meeting.status).toBe("scheduled");
  expect(detail.opportunity.status).toBe("scheduled");
});

it("holds historical bookings instead of reopening a lead's newer lost opportunity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin, closer } = await bookingHarness();
  const payload = bookingPayload("current");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-10-01T09:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [delivery] = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 1 },
    })
  ).page;
  if (!delivery.meetingId || !delivery.opportunityId)
    throw new Error("Fixture booking failed");
  await closer.mutation(api.closer.meetingActions.markAsLost, {
    opportunityId: delivery.opportunityId,
    meetingId: delivery.meetingId,
    reason: "Declined",
  });
  const historical = bookingPayload("historical");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: historical.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({
      created_at: "2026-09-25T09:00:00Z",
      payload: historical,
    }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (
      await admin.query(api.pipeline.delivery.list, {
        status: "blocked",
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page,
  ).toMatchObject([{ reason: "historical_booking_requires_review" }]);
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: delivery.meetingId,
  });
  expect(detail.opportunity.status).toBe("lost");
  expect(detail.meeting.status).toBe("completed");
});

it("records a malformed delivery as failed instead of losing the job", async () => {
  vi.useFakeTimers();
  const { bookingHarness } = await import("../../tests/bookingHarness");
  const { t, tenantId, admin } = await bookingHarness();
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: "malformed",
    eventType: "invitee.created",
    payload: "{",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (
      await admin.query(api.pipeline.delivery.list, {
        status: "failed",
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page,
  ).toMatchObject([{ reason: "processing_failed" }]);
});

it("rejects a reschedule link whose source meeting belongs to another opportunity", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { t, tenantId, admin, closer } = await bookingHarness();
  for (const name of ["target", "unrelated"]) {
    const payload = bookingPayload(name, `${name}@example.com`);
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  const bookings = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    })
  ).page;
  const [unrelated, target] = bookings;
  if (!target.opportunityId || !target.meetingId || !unrelated.meetingId)
    throw new Error("Fixture booking failed");
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    await ctx.db.patch("users", user!._id, {
      personalEventTypeUri: "https://calendly.com/closer/test",
    });
  });
  await closer.mutation(api.closer.noShowActions.markNoShow, {
    reason: "no_response",
    meetingId: target.meetingId,
  });
  await closer.mutation(api.closer.noShowActions.createNoShowRescheduleLink, {
    opportunityId: target.opportunityId,
    meetingId: target.meetingId,
  });
  const payload = {
    ...bookingPayload("bad-link", "target@example.com"),
    tracking: {
      utm_source: "ptdom",
      utm_medium: "noshow_resched",
      utm_campaign: target.opportunityId,
      utm_content: unrelated.meetingId,
    },
  };
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (
      await admin.query(api.pipeline.delivery.list, {
        status: "blocked",
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page,
  ).toMatchObject([{ reason: "invalid_booking_link" }]);
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: target.meetingId,
  });
  expect(detail.opportunity.status).toBe("reschedule_link_sent");
});

it("protects recovery from unauthorized roles and other tenants", async () => {
  vi.useFakeTimers();
  const { bookingHarness } = await import("../../tests/bookingHarness");
  const { t, tenantId, admin, closer } = await bookingHarness();
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: "malformed",
    eventType: "invitee.created",
    payload: "{",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [receipt] = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 1 },
    })
  ).page;
  const args = { deliveryIds: [receipt._id] };
  await expect(t.query(api.pipeline.recovery.preview, args)).rejects.toThrow();
  await expect(
    closer.query(api.pipeline.recovery.preview, args),
  ).rejects.toThrow();
  await t.run(async (ctx) => {
    const otherTenant = await ctx.db.insert("tenants", {
      companyName: "Other",
      contactEmail: "other@example.com",
      workosOrgId: "org_other",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId: otherTenant,
      workosUserId: "user_other",
      email: "other@example.com",
      role: "tenant_admin",
      isActive: true,
    });
  });
  const other = t.withIdentity({ subject: "user_other", org_id: "org_other" });
  await expect(
    other.query(api.pipeline.recovery.preview, args),
  ).rejects.toThrow("Delivery not found");
  const manifest = await admin.query(api.pipeline.recovery.preview, args);
  await expect(
    other.mutation(api.pipeline.recovery.retry, { manifest }),
  ).rejects.toThrow("Delivery not found");
});

it("preserves legacy form answers when their keys are upgraded more than once", async () => {
  vi.useFakeTimers();
  const { bookingHarness, bookingPayload } =
    await import("../../tests/bookingHarness");
  const { writeMeetingFormResponses } =
    await import("../lib/meetingFormResponses");
  const { t, tenantId, admin } = await bookingHarness();
  const payload = {
    ...bookingPayload("legacy-fields"),
    questions_and_answers: [{ question: "Goal", answer: "Grow" }],
  };
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [receipt] = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 1 },
    })
  ).page;
  if (!receipt.meetingId || !receipt.leadId || !receipt.opportunityId)
    throw new Error("Fixture booking failed");
  const meetingId = receipt.meetingId,
    leadId = receipt.leadId,
    opportunityId = receipt.opportunityId;
  await t.run(async (ctx) => {
    const response = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
      .unique();
    await ctx.db.patch("meetingFormResponses", response!._id, {
      fieldKey: "goal",
    });
    await ctx.db.patch("leads", leadId, {
      customFields: { Goal: "Grow" },
      customFieldLabels: undefined,
    });
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await t.run(async (ctx) => {
      const opportunity = await ctx.db.get("opportunities", opportunityId);
      await writeMeetingFormResponses(ctx, {
        tenantId,
        leadId,
        opportunityId,
        meetingId,
        eventTypeConfigId: opportunity!.eventTypeConfigId,
        capturedAt: Date.now(),
        questionsAndAnswers: [{ question: "Goal", answer: "Grow" }],
      });
    });
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId,
  });
  expect(Object.values(detail.lead.customFields!)).toEqual(["Grow"]);
  expect(Object.values(detail.lead.customFieldLabels!)).toEqual(["Goal"]);
  const responses = await t.run((ctx) =>
    ctx.db
      .query("meetingFormResponses")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
      .take(2),
  );
  expect(responses).toHaveLength(1);
  expect(responses[0].answerText).toBe("Grow");
  expect(responses[0].fieldKey).toMatch(/^q_[a-f0-9]{64}$/);
});
