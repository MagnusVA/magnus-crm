/**
 * "Is this the same person?": a booking whose email is new and whose phone
 * names one person who already has a different email is held, and an admin's
 * answer applies it. Held bookings from one email apply oldest first. Names,
 * emails and phones are made up.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => {
  vi.useRealTimers();
});

const PHONE = "+1 416-555-0142";
const PHONE_NORMALIZED = "+14165550142";
type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
  return await bookingHarness();
}

/** A person on file with an email and the shared phone. */
async function seedPhonePerson({ t, tenantId }: Harness) {
  return await t.run(async (ctx) => {
    const at = Date.parse("2026-10-20T00:00:00Z");
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(at),
      tenantId,
      fullName: "Jordan Example",
      email: "jordan@example.com",
      phone: PHONE,
      status: "active",
      firstSeenAt: at,
      updatedAt: at,
    });
    for (const [type, value] of [["email", "jordan@example.com"], ["phone", PHONE_NORMALIZED]] as const)
      await ctx.db.insert("leadIdentifiers", {
        tenantId, leadId, type, value, rawValue: value,
        source: "calendly_booking", confidence: "verified", createdAt: at,
      });
    return leadId;
  });
}

/** Delivers one booking; `minute` orders bookings by when they happened. */
async function deliver(
  { t, tenantId }: Harness,
  key: string,
  args: { email: string; minute?: number; phone?: string },
) {
  const payload = {
    ...bookingPayload(key, args.email),
    name: "Jordan Example",
    text_reminder_number: args.phone ?? PHONE,
  };
  const createdAt = new Date(Date.parse("2026-11-10T10:00:00Z") + (args.minute ?? 0) * 60_000);
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: createdAt.toISOString(), payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function receiptFor({ t }: Harness, key: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("webhookDeliveries").take(50)).find((row) => row.inviteeUri.includes(`/${key}/`))!,
  );
}

async function reviews({ t }: Harness) {
  return await t.run((ctx) => ctx.db.query("bookingReviews").take(20));
}

async function answer(harness: Harness, reviewId: Id<"bookingReviews">, decision: "same_person" | "different_person") {
  await harness.admin.mutation(api.pipeline.identityDecisions.decideIdentityCheck, { reviewId, decision });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

it("\"Same person\" applies the booking to the phone's person and adds the email, keeping their main email", async () => {
  const harness = await setup();
  const personId = await seedPhonePerson(harness);
  await deliver(harness, "same-1", { email: "jordan.new@example.com" });
  const [review] = await reviews(harness);
  expect(review).toMatchObject({ kind: "identity_check", status: "open" });

  await answer(harness, review._id, "same_person");

  expect(await receiptFor(harness, "same-1")).toMatchObject({ status: "applied", leadId: personId });
  const state = await harness.t.run(async (ctx) => ({
    person: await ctx.db.get("leads", personId),
    review: await ctx.db.get("bookingReviews", review._id),
    emailOwners: (await ctx.db.query("leadIdentifiers").take(20))
      .filter((i) => i.value === "jordan.new@example.com")
      .map((i) => i.leadId),
    attempts: await ctx.db.query("webhookRecoveryAttempts").take(5),
    decisions: await ctx.db.query("bookingIdentityDecisions").take(5),
  }));
  expect(state.person?.email).toBe("jordan@example.com");
  expect(state.emailOwners).toEqual([personId]);
  expect(state.review).toMatchObject({ status: "resolved", resolution: "same_person" });
  expect(state.attempts).toHaveLength(1);
  expect(state.decisions).toMatchObject([
    { email: "jordan.new@example.com", leadId: personId, decision: "same_person" },
  ]);

  // The person's next booking with that email applies with no review.
  await deliver(harness, "same-2", { email: "jordan.new@example.com", minute: 5 });
  expect(await receiptFor(harness, "same-2")).toMatchObject({ status: "applied", leadId: personId });
  expect(await reviews(harness)).toHaveLength(1);
});

it("\"Different person\" creates a new person with the email and no phone; the phone stays put and is remembered", async () => {
  const harness = await setup();
  const personId = await seedPhonePerson(harness);
  await deliver(harness, "diff-1", { email: "partner@example.com" });
  const [review] = await reviews(harness);

  await answer(harness, review._id, "different_person");

  const applied = await receiptFor(harness, "diff-1");
  expect(applied.status).toBe("applied");
  expect(applied.leadId).not.toBe(personId);
  const state = await harness.t.run(async (ctx) => ({
    newPerson: await ctx.db.get("leads", applied.leadId!),
    phoneOwners: (await ctx.db.query("leadIdentifiers").take(20))
      .filter((i) => i.value === PHONE_NORMALIZED)
      .map((i) => i.leadId),
    emailOwners: (await ctx.db.query("leadIdentifiers").take(20))
      .filter((i) => i.value === "partner@example.com")
      .map((i) => i.leadId),
  }));
  expect(state.newPerson).toMatchObject({ email: "partner@example.com" });
  expect(state.newPerson?.phone).toBeUndefined();
  expect(state.newPerson?.searchText ?? "").not.toContain("4165550142");
  expect(state.phoneOwners).toEqual([personId]);
  expect(state.emailOwners).toEqual([applied.leadId]);
  // No review about the phone for the new person.
  expect(await reviews(harness)).toHaveLength(1);

  // The new person books again with the same email and phone: no review.
  await deliver(harness, "diff-2", { email: "partner@example.com", minute: 5 });
  expect(await receiptFor(harness, "diff-2")).toMatchObject({ status: "applied", leadId: applied.leadId });
  expect(await reviews(harness)).toHaveLength(1);

  // The same phone with a third email asks again.
  await deliver(harness, "diff-3", { email: "third@example.com", minute: 10 });
  expect(await receiptFor(harness, "diff-3")).toMatchObject({ status: "blocked", reason: "phone_match_new_email" });
  const after = await reviews(harness);
  expect(after).toHaveLength(2);
  expect(after[1]).toMatchObject({ kind: "identity_check", status: "open", conflicts: [{ leadId: personId, via: "phone" }] });
});

it("held bookings from one email wait behind the oldest, and one answer applies them in order", async () => {
  const harness = await setup();
  const personId = await seedPhonePerson(harness);
  await deliver(harness, "order-1", { email: "jordan.new@example.com", minute: 0 });
  await deliver(harness, "order-2", { email: "jordan.new@example.com", minute: 5 });
  await deliver(harness, "order-3", { email: "jordan.new@example.com", minute: 10 });

  const first = await receiptFor(harness, "order-1");
  expect(first).toMatchObject({ status: "blocked", reason: "phone_match_new_email" });
  for (const key of ["order-2", "order-3"])
    expect(await receiptFor(harness, key)).toMatchObject({
      status: "blocked",
      reason: "waiting_for_earlier_booking",
      hold: { cause: "waiting_for_earlier_booking", waitingOnDeliveryId: first._id },
    });
  // Only the oldest asks the question.
  const [review] = await reviews(harness);
  expect(await reviews(harness)).toHaveLength(1);

  // Retrying the later ones first changes nothing: they still wait.
  const manifest = await harness.admin.query(api.pipeline.recovery.preview, {
    deliveryIds: [(await receiptFor(harness, "order-3"))._id, (await receiptFor(harness, "order-2"))._id],
  });
  await harness.admin.mutation(api.pipeline.recovery.retry, { manifest });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  for (const key of ["order-2", "order-3"])
    expect(await receiptFor(harness, key)).toMatchObject({ status: "blocked", reason: "waiting_for_earlier_booking" });

  await answer(harness, review._id, "same_person");

  for (const key of ["order-1", "order-2", "order-3"]) {
    const row = await receiptFor(harness, key);
    expect(row).toMatchObject({ status: "applied", leadId: personId });
    expect(row.holdKey).toBeUndefined();
    expect(row.hold).toBeUndefined();
  }
  expect(await reviews(harness)).toMatchObject([{ status: "resolved", resolution: "same_person" }]);
});

it("a new booking waits while an earlier one from its email is held, and the earlier one's apply releases it", async () => {
  const harness = await setup();
  await seedPhonePerson(harness);
  await deliver(harness, "late-1", { email: "partner@example.com", minute: 0 });
  const [review] = await reviews(harness);
  // A brand-new booking from the same email, with no phone this time.
  await deliver(harness, "late-2", { email: "partner@example.com", minute: 30, phone: "" });
  expect(await receiptFor(harness, "late-2")).toMatchObject({ status: "blocked", reason: "waiting_for_earlier_booking" });

  await answer(harness, review._id, "different_person");

  const first = await receiptFor(harness, "late-1");
  expect(first.status).toBe("applied");
  expect(await receiptFor(harness, "late-2")).toMatchObject({ status: "applied", leadId: first.leadId });
});

it("an earlier booking held for good doesn't hold later ones back", async () => {
  const harness = await setup();
  await harness.t.run(async (ctx) => {
    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      tenantId: harness.tenantId, calendlyEventUri: "https://api.calendly.com/scheduled_events/old",
      eventType: "invitee.created", payload: "{}", processed: false, receivedAt: 0,
    });
    const { holdKeyFor } = await import("./holdOrder");
    await ctx.db.insert("webhookDeliveries", {
      tenantId: harness.tenantId, key: "old", eventType: "invitee.created",
      inviteeUri: "https://api.calendly.com/scheduled_events/old/invitees/person", rawEventId,
      occurredAt: 0, receivedAt: 0, status: "blocked", reason: "historical_booking_requires_review",
      generation: 1, holdKey: await holdKeyFor(harness.tenantId, "solo@example.com"),
    });
  });
  await deliver(harness, "after-historical", { email: "solo@example.com", phone: "" });
  expect(await receiptFor(harness, "after-historical")).toMatchObject({ status: "applied" });
});

it("a placeholder email's answer covers that one booking", async () => {
  const harness = await setup();
  const personId = await seedPhonePerson(harness);
  await deliver(harness, "placeholder-1", { email: "email@gmail.com" });
  const [review] = await reviews(harness);
  expect(review).toMatchObject({ kind: "identity_check", booking: { phone: PHONE_NORMALIZED } });
  expect(review.booking.email).toBeUndefined();

  await answer(harness, review._id, "same_person");

  const applied = await receiptFor(harness, "placeholder-1");
  expect(applied).toMatchObject({ status: "applied", leadId: personId });
  expect(await harness.t.run((ctx) => ctx.db.query("bookingIdentityDecisions").take(5))).toMatchObject([
    { deliveryId: applied._id, leadId: personId, decision: "same_person" },
  ]);
  // Another placeholder booking against the same person asks again.
  await deliver(harness, "placeholder-2", { email: "email@gmail.com", minute: 5 });
  expect(await receiptFor(harness, "placeholder-2")).toMatchObject({ status: "blocked", reason: "phone_match_new_email" });
});

it("\"Same person\" is refused once the email belongs to someone else", async () => {
  const harness = await setup();
  await seedPhonePerson(harness);
  await deliver(harness, "taken", { email: "jordan.new@example.com" });
  const [review] = await reviews(harness);
  await harness.t.run(async (ctx) => {
    await ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId: harness.tenantId, email: "jordan.new@example.com",
      status: "active", firstSeenAt: 0, updatedAt: 0,
    });
  });
  await expect(
    harness.admin.mutation(api.pipeline.identityDecisions.decideIdentityCheck, {
      reviewId: review._id,
      decision: "same_person",
    }),
  ).rejects.toThrow("belongs to another person");
  expect(await harness.t.run((ctx) => ctx.db.query("bookingIdentityDecisions").take(5))).toEqual([]);
});

it("a review is answered once: a second answer is refused and writes nothing", async () => {
  const harness = await setup();
  await seedPhonePerson(harness);
  await deliver(harness, "twice", { email: "jordan.new@example.com" });
  const [review] = await reviews(harness);
  await harness.admin.mutation(api.pipeline.identityDecisions.decideIdentityCheck, {
    reviewId: review._id,
    decision: "same_person",
  });
  // The booking is queued for its retry: the other answer is refused.
  await expect(
    harness.admin.mutation(api.pipeline.identityDecisions.decideIdentityCheck, {
      reviewId: review._id,
      decision: "different_person",
    }),
  ).rejects.toThrow("already resolved");
  const state = await harness.t.run(async (ctx) => ({
    decisions: await ctx.db.query("bookingIdentityDecisions").take(5),
    attempts: await ctx.db.query("webhookRecoveryAttempts").take(5),
  }));
  expect(state.decisions).toHaveLength(1);
  expect(state.attempts).toHaveLength(1);
});

it("a merge doesn't close \"Is this the same person?\", and merge actions refuse it", async () => {
  const harness = await setup();
  await seedPhonePerson(harness);
  await deliver(harness, "merge-guard", { email: "jordan.new@example.com" });
  const [review] = await reviews(harness);
  await expect(
    harness.admin.mutation(api.pipeline.bookingReviews.closeAsMerged, { reviewId: review._id }),
  ).rejects.toThrow("Same person or Different person");
  await expect(
    harness.admin.mutation(api.pipeline.bookingReviews.keepSeparate, { reviewId: review._id }),
  ).rejects.toThrow("Same person or Different person");

  // An unrelated two-person held review merged elsewhere sweeps open reviews.
  const [a, b] = await harness.t.run(async (ctx) => {
    const ids = [];
    for (const [email, phone] of [["a@example.com", undefined], [undefined, "+1 647-555-0100"]] as const) {
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(0), tenantId: harness.tenantId, status: "active", firstSeenAt: 0, updatedAt: 0,
        ...(email && { email }), ...(phone && { phone }),
      });
      await ctx.db.insert("leadIdentifiers", {
        tenantId: harness.tenantId, leadId, type: email ? "email" : "phone", value: email ?? "+16475550100",
        rawValue: email ?? phone!, source: "calendly_booking", confidence: "verified", createdAt: 0,
      });
      ids.push(leadId);
    }
    return ids;
  });
  await deliver(harness, "two-people", { email: "a@example.com", phone: "+1 647-555-0100", minute: 5 });
  const held = (await reviews(harness)).find((r) => r.kind === "held")!;
  await harness.admin.mutation(api.pipeline.bookingReviews.mergePeople, { reviewId: held._id, keepLeadId: a });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await harness.t.run((ctx) => ctx.db.get("leads", b))).toMatchObject({ status: "merged" });
  expect(await harness.t.run((ctx) => ctx.db.get("bookingReviews", review._id))).toMatchObject({
    kind: "identity_check",
    status: "open",
  });
});

it("only the tenant's admins can see or answer the review", async () => {
  const harness = await setup();
  await seedPhonePerson(harness);
  await deliver(harness, "tenant-boundary", { email: "jordan.new@example.com" });
  const [review] = await reviews(harness);
  await harness.t.run(async (ctx) => {
    const otherTenant = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "other@example.com",
      workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId: otherTenant, workosUserId: "user_other_admin", email: "other@example.com",
      role: "tenant_admin", isActive: true,
    });
  });
  const otherAdmin = harness.t.withIdentity({ subject: "user_other_admin", org_id: "org_other" });

  expect(await otherAdmin.query(api.pipeline.bookingReviews.get, { reviewId: review._id })).toBeNull();
  await expect(
    otherAdmin.mutation(api.pipeline.identityDecisions.decideIdentityCheck, {
      reviewId: review._id,
      decision: "same_person",
    }),
  ).rejects.toThrow("not found");
  await expect(
    harness.closer.mutation(api.pipeline.identityDecisions.decideIdentityCheck, {
      reviewId: review._id,
      decision: "same_person",
    }),
  ).rejects.toThrow();
  expect(await harness.t.run((ctx) => ctx.db.query("bookingIdentityDecisions").take(5))).toEqual([]);
});

it("one tenant's answer is never read for another tenant's booking with the same email", async () => {
  const harness = await setup();
  await seedPhonePerson(harness);
  await deliver(harness, "tenant-one", { email: "partner@example.com" });
  const [review] = await reviews(harness);
  await answer(harness, review._id, "different_person");

  const otherTenant = await harness.t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "other@example.com",
      workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
    }),
  );
  await seedPhonePerson({ ...harness, tenantId: otherTenant });
  await deliver({ ...harness, tenantId: otherTenant }, "tenant-two", { email: "partner@example.com", minute: 5 });

  expect(await receiptFor(harness, "tenant-two")).toMatchObject({
    tenantId: otherTenant,
    status: "blocked",
    reason: "phone_match_new_email",
  });
});
