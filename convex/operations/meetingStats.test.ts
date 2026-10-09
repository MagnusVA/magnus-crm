import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());
it("counts a booked meeting once after recording a no-show", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId, admin, closer } = await bookingHarness();
  const payload = bookingPayload("no-show");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-10-01T10:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  const deliveries = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  const meetingId = deliveries.page[0].meetingId;
  expect(meetingId).toBeDefined();
  if (!meetingId) throw new Error("Booking was not applied");
  await closer.mutation(api.closer.noShowActions.markNoShow, {
    meetingId,
    reason: "no_response",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    }),
  ).toMatchObject({ scheduled: 1, noShows: 1, canceled: 0 });
});

it("does not report an empty replacement table as zero during migration", async () => {
  const { t, tenantId, admin } = await bookingHarness();
  await t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("calendlyUserUri", "https://api.calendly.com/users/closer"),
      )
      .unique();
    if (!closer) throw new Error("Missing fixture closer");
    await ctx.db.insert("operationsMeetingDailyStats", {
      tenantId,
      assignedCloserId: closer._id,
      dayKey: "2026-10-01",
      meetingStatus: "scheduled",
      count: 5,
      updatedAt: 0,
    });
  });
  await expect(
    admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    }),
  ).rejects.toThrow("Reporting rebuild has not been verified");
});

it("projects every historical meeting when an opportunity with over 200 meetings changes", async () => {
  vi.useFakeTimers();
  const { t, tenantId, admin, closer } = await bookingHarness();
  const payload = bookingPayload("long-history");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  const [delivery] = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 1 },
    })
  ).page;
  if (!delivery.meetingId || !delivery.opportunityId)
    throw new Error("Fixture booking failed");
  await t.run(async (ctx) => {
    const original = await ctx.db.get("meetings", delivery.meetingId!);
    if (!original) throw new Error("Fixture meeting missing");
    const { _id, _creationTime, ...fields } = original;
    void _id;
    void _creationTime;
    for (let i = 1; i < 205; i++)
      await ctx.db.insert("meetings", {
        ...fields,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/history-${i}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/history-${i}/invitees/test`,
      });
  });
  await closer.mutation(api.closer.meetingActions.markAsLost, {
    opportunityId: delivery.opportunityId,
    reason: "Not proceeding",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
      opportunityStatus: "lost",
    }),
  ).toMatchObject({ scheduled: 205 });
});

it("includes a production-sized month with more than 1000 stats rows", async () => {
  const { t, tenantId, admin } = await bookingHarness();
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!user) throw new Error("Fixture user missing");
    for (let i = 0; i < 1300; i++)
      await ctx.db.insert("operationsMeetingStatsV2", {
        tenantId,
        assignedCloserId: user._id,
        dayKey: "2026-10-01",
        bucketKey: `fixture-${i}`,
        meetingStatus: "scheduled",
        count: 1,
        updatedAt: 0,
      });
  });
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    }),
  ).toMatchObject({ scheduled: 1300 });
});

it("keeps a paid meeting completed and counted once when a late cancellation arrives", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId, admin, closer } = await bookingHarness();
  const payload = bookingPayload("paid");
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
  const programId = await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!user) throw new Error("Fixture user missing");
    return await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      updatedAt: 0,
      createdByUserId: user._id,
    });
  });
  await closer.mutation(api.closer.payments.logPayment, {
    opportunityId: delivery.opportunityId,
    meetingId: delivery.meetingId,
    amount: 100,
    currency: "USD",
    programId,
    paymentType: "pif",
  });
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.canceled",
    payload: JSON.stringify({ created_at: "2026-10-01T10:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const detail = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: delivery.meetingId,
  });
  expect(detail.meeting.status).toBe("completed");
  expect(detail.opportunity.status).toBe("payment_received");
  expect(detail.payments).toHaveLength(1);
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
      soldProgramId: programId,
    }),
  ).toMatchObject({ scheduled: 1, completed: 1, won: 1, canceled: 0 });
});

it("keeps a closer outcome when reporting fails and repairs the report through a guarded retry", async () => {
  vi.useFakeTimers();
  const { t, tenantId, admin, closer } = await bookingHarness();
  const payload = bookingPayload("report-failure");
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [delivery] = (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 1 },
    })
  ).page;
  if (!delivery.meetingId) throw new Error("Fixture booking failed");
  // Inject a broken downstream projection, without changing the source booking.
  const bucket = await t.run(async (ctx) => {
    const row = await ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!row) throw new Error("Fixture bucket missing");
    await ctx.db.delete("operationsMeetingStatsV2", row._id);
    const { _id, _creationTime, ...fields } = row;
    void _id;
    void _creationTime;
    return fields;
  });
  await closer.mutation(api.closer.noShowActions.markNoShow, {
    meetingId: delivery.meetingId,
    reason: "no_response",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    (
      await admin.query(api.closer.meetingDetail.getMeetingDetail, {
        meetingId: delivery.meetingId,
      })
    ).meeting.status,
  ).toBe("no_show");
  const failed = await admin.query(api.operations.workStatus.list, {
    kind: "meeting",
    status: "failed",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(failed.page).toHaveLength(1);
  expect(failed.page[0].reason).toBe("projection_failed");
  await t.run(async (ctx) => {
    await ctx.db.insert("operationsMeetingStatsV2", bucket);
  });
  const retry = {
    kind: "meeting" as const,
    id: failed.page[0].id,
    generation: failed.page[0].generation,
  };
  await admin.mutation(api.operations.workStatus.retry, retry);
  await expect(
    admin.mutation(api.operations.workStatus.retry, retry),
  ).rejects.toThrow("Projection retry is stale");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    await admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    }),
  ).toMatchObject({ scheduled: 1, noShows: 1 });
});
