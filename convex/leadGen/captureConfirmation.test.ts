/**
 * The capture tells the lead generator where the person stood before it
 * (docs/plans/respark.md §5.4, §6.5).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { DEFAULT_RESPARK_SETTINGS } from "../lib/respark/settings";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-20T12:00:00Z");

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  return await bookingHarness();
}

async function capture(harness: Harness, handle: string, at: number) {
  vi.setSystemTime(new Date(at));
  return await harness.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram",
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: "follower",
  });
}

async function onlyLead(harness: Harness) {
  const all = await harness.t.run((ctx) => ctx.db.query("leads").take(10));
  expect(all).toHaveLength(1);
  return all[0];
}

describe("capture confirmation", () => {
  it("says a new person was captured, with no last touch", async () => {
    const harness = await setup();

    const result = await capture(harness, "ana.lead", NOW);

    expect(result.duplicateProspect).toBe(false);
    expect(result.inactiveAfterDays).toBe(DEFAULT_RESPARK_SETTINGS.inactiveAfterDays);
    expect(result.person).toMatchObject({
      isNew: true,
      stage: "in_conversation",
      disposition: "open",
    });
    expect(result.person?.lastTouchAt).toBeUndefined();
    expect(result.person?.nextMeetingAt).toBeUndefined();
  });

  it("gives a known person's last touch from before this capture", async () => {
    const harness = await setup();
    await capture(harness, "ana.lead", NOW);
    const later = NOW + 127 * DAY_MS;

    const result = await capture(harness, "ana.lead", later);

    expect(result.duplicateProspect).toBe(true);
    expect(result.person).toMatchObject({
      isNew: false,
      stage: "in_conversation",
      disposition: "open",
      lastTouchAt: NOW,
    });
    expect(result.person?.nextMeetingAt).toBeUndefined();
    expect((await onlyLead(harness)).lastTouch?.occurredAt).toBe(later);
  });

  it("gives a booked person's next call", async () => {
    const harness = await setup();
    await capture(harness, "ana.lead", NOW);
    const lead = await onlyLead(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("leads", lead._id, { email: "lead@example.com" });
      await ctx.db.insert("leadIdentifiers", {
        tenantId: harness.tenantId, leadId: lead._id, type: "email", value: "lead@example.com",
        rawValue: "lead@example.com", source: "manual_entry", confidence: "verified", createdAt: NOW,
      });
    });
    const bookedAt = NOW + DAY_MS;
    vi.setSystemTime(new Date(bookedAt));
    const payload = bookingPayload("booked-call");
    await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId: harness.tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: new Date(bookedAt).toISOString(), payload }),
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await onlyLead(harness)).lifecycleStage).toBe("booked");

    const result = await capture(harness, "ana.lead", bookedAt + DAY_MS);

    expect(result.person).toMatchObject({
      isNew: false,
      stage: "booked",
      nextMeetingAt: Date.parse(payload.scheduled_event.start_time),
    });
    expect((await onlyLead(harness)).lifecycleStage).toBe("booked");
  });

  it("says who set not a fit and when, and leaves it alone", async () => {
    const harness = await setup();
    await capture(harness, "ana.lead", NOW);
    const lead = await onlyLead(harness);
    const markedAt = NOW + DAY_MS;
    await harness.t.run((ctx) =>
      ctx.db.patch("leads", lead._id, {
        disposition: "not_a_fit",
        dispositionSource: "respark",
        dispositionSetAt: markedAt,
      }),
    );

    const result = await capture(harness, "ana.lead", NOW + 2 * DAY_MS);

    expect(result.person).toMatchObject({
      isNew: false,
      disposition: "not_a_fit",
      dispositionSource: "respark",
      dispositionSetAt: markedAt,
    });
    const after = await onlyLead(harness);
    expect(after.disposition).toBe("not_a_fit");
    expect(after.dispositionSource).toBe("respark");
    expect(after.dispositionSetAt).toBe(markedAt);
  });
});
