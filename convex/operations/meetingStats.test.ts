import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { bucketKey, requestMeetingProjection } from "./meetingStats";

afterEach(() => vi.useRealTimers());

/** The bucket key before Phase 3 took attribution out of it. */
function legacyBucketKey(c: NonNullable<Doc<"meetingProjections">["contribution"]>) {
  return JSON.stringify([
    c.dayKey,
    c.assignedCloserId,
    c.bookingProgramId ?? null,
    c.soldProgramId ?? null,
    c.attributionTeamId ?? null,
    c.dmCloserId ?? null,
    c.opportunityStatus ?? null,
    c.meetingStatus,
  ]);
}

it("re-keys a meeting projected under the old bucket key, and deletes the old bucket at zero", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("legacy-key");
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
  if (!delivery.meetingId) throw new Error("Fixture booking failed");
  const firstId = delivery.meetingId;

  // Put two meetings back where the old code left them: the team and DM
  // closer in the contribution and in one shared eight-part bucket key.
  const { secondId, oldKey } = await t.run(async (ctx) => {
    const teamId = await ctx.db.insert("attributionTeams", {
      tenantId,
      slug: "team",
      displayName: "Team",
      utmSource: "team",
      normalizedUtmSource: "team",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    const dmCloserId = await ctx.db.insert("dmClosers", {
      tenantId,
      teamId,
      slug: "dm",
      displayName: "DM",
      utmMedium: "dm",
      normalizedUtmMedium: "dm",
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    });
    const first = (await ctx.db.get("meetings", firstId))!;
    const { _id, _creationTime, ...fields } = first;
    void _id;
    void _creationTime;
    const secondId = await ctx.db.insert("meetings", {
      ...fields,
      calendlyEventUri: "https://api.calendly.com/scheduled_events/legacy-key-2",
      calendlyInviteeUri: "https://api.calendly.com/scheduled_events/legacy-key-2/invitees/person",
    });
    const projection = await ctx.db
      .query("meetingProjections")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", firstId))
      .unique();
    if (!projection?.contribution || !projection.bucketKey) throw new Error("Fixture projection missing");
    const newBucket = await ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_bucketKey", (q) =>
        q.eq("tenantId", tenantId).eq("bucketKey", projection.bucketKey!),
      )
      .unique();
    await ctx.db.delete("operationsMeetingStatsV2", newBucket!._id);
    const contribution = { ...projection.contribution, attributionTeamId: teamId, dmCloserId };
    const oldKey = legacyBucketKey(contribution);
    await ctx.db.insert("operationsMeetingStatsV2", {
      tenantId,
      ...contribution,
      bucketKey: oldKey,
      count: 2,
      updatedAt: 0,
    });
    for (const meetingId of [firstId, secondId]) {
      await ctx.db.patch("meetings", meetingId, { attributionTeamId: teamId, dmCloserId });
    }
    await ctx.db.patch("meetingProjections", projection._id, { contribution, bucketKey: oldKey });
    await ctx.db.insert("meetingProjections", {
      tenantId,
      meetingId: secondId,
      generation: 1,
      status: "applied",
      requestedAt: 0,
      appliedAt: 0,
      contribution,
      bucketKey: oldKey,
    });
    return { secondId, oldKey };
  });
  const bucketCount = (key: string) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("operationsMeetingStatsV2")
          .withIndex("by_tenantId_and_bucketKey", (q) => q.eq("tenantId", tenantId).eq("bucketKey", key))
          .unique()
      )?.count ?? 0,
    );
  const projectionOf = (meetingId: typeof firstId) =>
    t.run(async (ctx) =>
      await ctx.db
        .query("meetingProjections")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
        .unique(),
    );
  const stats = () =>
    admin.query(api.operations.phoneSales.getPhoneSalesStats, {
      scheduledFrom: Date.parse("2026-10-01T00:00:00Z"),
      scheduledTo: Date.parse("2026-10-02T00:00:00Z"),
    });

  // The rebuild: nothing about the meeting changed but the key format.
  await t.run(async (ctx) => await requestMeetingProjection(ctx, tenantId, firstId));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const rekeyed = await projectionOf(firstId);
  expect(rekeyed).toMatchObject({ status: "applied" });
  expect(rekeyed?.contribution).not.toHaveProperty("attributionTeamId");
  expect(rekeyed?.contribution).not.toHaveProperty("dmCloserId");
  expect(rekeyed?.bucketKey).toBe(bucketKey(rekeyed!.contribution!));
  expect(rekeyed?.bucketKey).not.toBe(oldKey);
  expect(await bucketCount(oldKey)).toBe(1);
  expect(await bucketCount(rekeyed!.bucketKey!)).toBe(1);
  // Old and new buckets coexist; each meeting counts once.
  expect(await stats()).toMatchObject({ scheduled: 2, noShows: 0 });

  // A status change on the other meeting decrements its stored old key. The
  // copy is not in the status aggregate, so patch it the way the write path
  // would for the projection.
  await t.run(async (ctx) => {
    await ctx.db.patch("meetings", secondId, { status: "no_show" });
    await requestMeetingProjection(ctx, tenantId, secondId);
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const second = await projectionOf(secondId);
  expect(second).toMatchObject({ status: "applied" });
  expect(second?.bucketKey).toBe(bucketKey(second!.contribution!));
  expect(await bucketCount(oldKey)).toBe(0);
  expect(await bucketCount(second!.bucketKey!)).toBe(1);
  expect(await stats()).toMatchObject({ scheduled: 2, noShows: 1 });
  const failed = await admin.query(api.operations.workStatus.list, {
    kind: "meeting",
    status: "failed",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(failed.page).toHaveLength(0);
});

it("decrements a deleted meeting's old-key bucket", async () => {
  vi.useFakeTimers();
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("legacy-delete");
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
  const meetingId = delivery.meetingId;
  const oldKey = await t.run(async (ctx) => {
    const projection = (await ctx.db
      .query("meetingProjections")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
      .unique())!;
    const bucket = (await ctx.db
      .query("operationsMeetingStatsV2")
      .withIndex("by_tenantId_and_bucketKey", (q) =>
        q.eq("tenantId", tenantId).eq("bucketKey", projection.bucketKey!),
      )
      .unique())!;
    const oldKey = legacyBucketKey(projection.contribution!);
    await ctx.db.patch("operationsMeetingStatsV2", bucket._id, { bucketKey: oldKey });
    await ctx.db.patch("meetingProjections", projection._id, { bucketKey: oldKey });
    // Deleting a meeting requests its projection first (docs/agents/convex.md).
    await requestMeetingProjection(ctx, tenantId, meetingId);
    await ctx.db.delete("meetings", meetingId);
    return oldKey;
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.run(async (ctx) => {
    const projection = await ctx.db
      .query("meetingProjections")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
      .unique();
    expect(projection).toMatchObject({ status: "applied" });
    expect(projection?.contribution).toBeUndefined();
    expect(projection?.bucketKey).toBeUndefined();
    expect(
      await ctx.db
        .query("operationsMeetingStatsV2")
        .withIndex("by_tenantId_and_bucketKey", (q) => q.eq("tenantId", tenantId).eq("bucketKey", oldKey))
        .unique(),
    ).toBeNull();
  });
});
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
