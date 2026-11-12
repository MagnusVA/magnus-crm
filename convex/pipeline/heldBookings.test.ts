/**
 * The recovery panel's held bookings, the plain-language reason for each
 * hold, and the one Slack post for a held booking that has no review. Names,
 * emails and phones are made up.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { holdNextStep } from "./holdNextStep";

afterEach(() => {
  vi.useRealTimers();
});

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
  return await bookingHarness();
}

async function seedPerson({ t, tenantId }: Harness, fullName: string, email: string, phone: string) {
  return await t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId, fullName, email, phone, status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    for (const [type, value] of [["email", email], ["phone", phone]] as const)
      await ctx.db.insert("leadIdentifiers", {
        tenantId, leadId, type, value, rawValue: value, source: "calendly_booking", confidence: "verified", createdAt: 0,
      });
    return leadId;
  });
}

async function deliver({ t, tenantId }: Harness, key: string, email: string, phone: string) {
  const payload = {
    ...bookingPayload(key, email),
    name: "Jordan Example",
    text_reminder_number: phone,
    scheduled_event: { ...bookingPayload(key, email).scheduled_event, name: "Strategy Call" },
  };
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-11-10T10:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function heldAlertJobs({ t }: Harness) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").take(100)).filter(
      (job) => job.name === "slack/heldBookingNotify:post",
    ),
  );
}

it("every reason the pipeline holds with reads in plain words, and an unknown one needs an operator", () => {
  for (const reason of [
    "phone_match_new_email", "identity_conflict", "waiting_for_earlier_booking", "host_not_linked",
    "host_inactive", "invalid_identity_relationship", "invalid_booking_link", "previous_booking_missing",
    "booking_not_tracked", "historical_booking_requires_review", "booking_history_requires_review",
    "follow_up_history_requires_review", "booking_target_requires_review", "ambiguous_booking_target",
    "ambiguous_follow_up", "ambiguous_booking_identity", "processing_failed", "work_canceled",
  ]) {
    const explained = holdNextStep(reason);
    expect(explained.cause).not.toContain(reason);
    expect(explained.nextStep.length).toBeGreaterThan(0);
  }
  expect(holdNextStep("something_new")).toMatchObject({
    cause: "Held with code something_new.",
    needsOperator: true,
  });
});

it("the panel explains a held booking: the call, the closer, what was typed, who matched and the next step", async () => {
  const harness = await setup();
  const personId = await seedPerson(harness, "Jordan Example", "jordan@example.com", "+14165550142");
  await deliver(harness, "panel", "jordan.new@example.com", "+1 416-555-0142");

  const { page } = await harness.admin.query(api.pipeline.heldBookings.list, {
    paginationOpts: { cursor: null, numItems: 25 },
    status: "blocked",
  });
  expect(page).toHaveLength(1);
  expect(page[0]).toMatchObject({
    status: "blocked",
    reason: "phone_match_new_email",
    inviteeName: "Jordan Example",
    email: "jordan.new@example.com",
    phone: "+14165550142",
    eventName: "Strategy Call",
    startTime: Date.parse("2026-10-01T12:00:00Z"),
    closerName: "closer@example.com",
    payloadAvailable: true,
    reviewOpen: true,
    matches: [{ leadId: personId, name: "Jordan Example", via: ["phone"] }],
    explanation: { nextStep: "Open the review and say whether this is the same person." },
  });
  // The booking has a review, so the review's alert covers it.
  expect(await heldAlertJobs(harness)).toEqual([]);
});

it("a held booking with no review is posted to Slack once, however often it's retried", async () => {
  const harness = await setup();
  // Two people share one phone: no same-or-different question can settle it.
  await seedPerson(harness, "Lead A", "a@example.com", "+14165550142");
  await harness.t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId: harness.tenantId, fullName: "Lead B", status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    await ctx.db.insert("leadIdentifiers", {
      tenantId: harness.tenantId, leadId, type: "phone", value: "+14165550142", rawValue: "+14165550142",
      source: "calendly_booking", confidence: "verified", createdAt: 0,
    });
  });
  await deliver(harness, "shared", "someone@example.com", "+1 416-555-0142");

  const [row] = (
    await harness.admin.query(api.pipeline.heldBookings.list, {
      paginationOpts: { cursor: null, numItems: 25 },
      status: "blocked",
    })
  ).page;
  expect(row).toMatchObject({ reason: "identity_conflict", reviewOpen: false });
  expect(row.reviewId).toBeUndefined();
  expect(row.matches.map((m) => m.via)).toEqual([["phone"], ["phone"]]);
  // The post ran with no Slack channel set, so nothing was marked posted.
  expect(await heldAlertJobs(harness)).toHaveLength(1);

  // Marked posted, a retry that holds again schedules nothing more.
  await harness.t.mutation(internal.pipeline.heldBookings.markAlerted, { deliveryId: row.deliveryId });
  const manifest = await harness.admin.query(api.pipeline.recovery.preview, { deliveryIds: [row.deliveryId] });
  await harness.admin.mutation(api.pipeline.recovery.retry, { manifest });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await heldAlertJobs(harness)).toHaveLength(1);
});

it("another tenant's admin and a closer can't list held bookings", async () => {
  const harness = await setup();
  await seedPerson(harness, "Jordan Example", "jordan@example.com", "+14165550142");
  await deliver(harness, "boundary", "jordan.new@example.com", "+1 416-555-0142");
  await harness.t.run(async (ctx) => {
    const otherTenant = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "other@example.com",
      workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId: otherTenant, workosUserId: "user_other_admin", email: "other@example.com", role: "tenant_admin", isActive: true,
    });
  });
  const otherAdmin = harness.t.withIdentity({ subject: "user_other_admin", org_id: "org_other" });
  const args = { paginationOpts: { cursor: null, numItems: 25 }, status: "blocked" as const };
  expect((await otherAdmin.query(api.pipeline.heldBookings.list, args)).page).toEqual([]);
  await expect(harness.closer.query(api.pipeline.heldBookings.list, args)).rejects.toThrow();
});
