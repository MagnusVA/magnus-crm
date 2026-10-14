import { afterEach, beforeEach, expect, it, vi } from "vitest";
import migrationsTest from "@convex-dev/migrations/test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { migrations } from "../migrations";
import { DISMISS_BLOCKED_BEFORE, DISMISSED_REASON } from "./dismissal";
import { deliveryMetadata } from "./receipts";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(DISMISS_BLOCKED_BEFORE + 2 * 60 * 60 * 1000);
});
afterEach(() => vi.useRealTimers());

type Seed = {
  status: "blocked" | "applied" | "queued";
  reason?: string;
  receivedAt: number;
  raw?: boolean;
};

async function setup() {
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const { t, tenantId } = harness;

  async function seed({ status, reason, receivedAt, raw: keepRaw = true }: Seed) {
    const eventUri = `https://api.calendly.com/scheduled_events/ev-${receivedAt}-${status}`;
    const raw = {
      calendlyEventUri: `${eventUri}/invitees/x`,
      eventType: "invitee.created",
      payload: JSON.stringify({ event: "invitee.created", payload: { scheduled_event: { uri: eventUri } } }),
      receivedAt,
    };
    // Cleanup re-derives the receipt key from the raw event, so seed the real key.
    const { key } = await deliveryMetadata(raw);
    return await t.run(async (ctx) => {
      const rawEventId = await ctx.db.insert("rawWebhookEvents", {
        ...raw,
        tenantId,
        processed: status === "applied",
      });
      const deliveryId = await ctx.db.insert("webhookDeliveries", {
        tenantId,
        key,
        eventType: "invitee.created",
        inviteeUri: raw.calendlyEventUri,
        eventUri,
        rawEventId,
        occurredAt: receivedAt,
        receivedAt,
        status,
        reason,
        generation: 2,
      });
      if (!keepRaw) await ctx.db.delete("rawWebhookEvents", rawEventId);
      return deliveryId;
    });
  }

  async function runMigration(name: string, extra: Record<string, unknown> = {}) {
    await t.mutation(internal.migrations.run, { fn: `migrations:${name}`, ...extra });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [status] = await t.run((ctx) =>
      migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
    );
    return status;
  }

  async function delivery(id: Id<"webhookDeliveries">) {
    return await t.run(async (ctx) => {
      const row = (await ctx.db.get("webhookDeliveries", id))!;
      const raw = await ctx.db.get("rawWebhookEvents", row.rawEventId);
      const logs = await ctx.db
        .query("webhookDeliveryDismissals")
        .withIndex("by_deliveryId", (q) => q.eq("deliveryId", id))
        .take(10);
      return { row, raw, logs };
    });
  }

  return { ...harness, seed, runMigration, delivery };
}

async function seedBacklog(h: Awaited<ReturnType<typeof setup>>) {
  const before = DISMISS_BLOCKED_BEFORE;
  return {
    legacy: await h.seed({ status: "blocked", reason: "legacy_delivery_requires_review", receivedAt: before - 90 * DAY }),
    legacyNoRaw: await h.seed({ status: "blocked", reason: "legacy_delivery_requires_review", receivedAt: before - 80 * DAY, raw: false }),
    recent: await h.seed({ status: "blocked", reason: "ambiguous_booking_target", receivedAt: before - 3 * 60 * 60 * 1000 }),
    afterCutoff: await h.seed({ status: "blocked", reason: "host_not_linked", receivedAt: before + 60 * 1000 }),
    applied: await h.seed({ status: "applied", receivedAt: before - 5 * DAY }),
    queued: await h.seed({ status: "queued", receivedAt: before - 4 * DAY }),
  };
}

it("previews exactly the blocked deliveries received before the cutoff", async () => {
  const h = await setup();
  await seedBacklog(h);
  expect(await h.t.query(internal.pipeline.dismissal.previewBlockedBacklogDismissal, {})).toEqual({
    toDismiss: 3,
    capped: false,
    rawPayloadsMissing: 1,
    byReason: [
      { reason: "legacy_delivery_requires_review", count: 2 },
      { reason: "ambiguous_booking_target", count: 1 },
    ],
    blockedAfterCutoff: 1,
  });
});

it("a dry run changes nothing", async () => {
  const h = await setup();
  const ids = await seedBacklog(h);
  await expect(
    h.t.mutation(internal.migrations.run, { fn: "migrations:dismissBlockedBacklog", dryRun: true }),
  ).resolves.toBeDefined();
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const { row, raw, logs } = await h.delivery(ids.legacy);
  expect(row).toMatchObject({ status: "blocked", reason: "legacy_delivery_requires_review", generation: 2 });
  expect(raw?.processed).toBe(false);
  expect(logs).toHaveLength(0);
});

it("dismisses the pre-cutoff blocked backlog, logs it, and leaves everything else alone", async () => {
  const h = await setup();
  const ids = await seedBacklog(h);
  expect((await h.runMigration("assertBlockedBacklogDismissed"))?.state).toBe("failed");

  expect((await h.runMigration("dismissBlockedBacklog"))?.isDone).toBe(true);

  for (const id of [ids.legacy, ids.recent]) {
    const { row, raw, logs } = await h.delivery(id);
    expect(row).toMatchObject({ status: "ignored", reason: DISMISSED_REASON, generation: 3 });
    expect(raw).toMatchObject({ processed: true, processingReason: DISMISSED_REASON });
    expect(logs).toEqual([expect.objectContaining({ previousStatus: "blocked", previousGeneration: 2 })]);
  }
  expect((await h.delivery(ids.legacyNoRaw)).row).toMatchObject({ status: "ignored", reason: DISMISSED_REASON });
  expect((await h.delivery(ids.recent)).logs[0].previousReason).toBe("ambiguous_booking_target");
  expect((await h.delivery(ids.afterCutoff)).row).toMatchObject({ status: "blocked", reason: "host_not_linked", generation: 2 });
  expect((await h.delivery(ids.applied)).row).toMatchObject({ status: "applied", generation: 2 });
  expect((await h.delivery(ids.queued)).row).toMatchObject({ status: "queued", generation: 2 });

  expect((await h.runMigration("assertBlockedBacklogDismissed", { reset: true }))?.isDone).toBe(true);
  expect(await h.t.query(internal.pipeline.dismissal.previewBlockedBacklogDismissal, {})).toMatchObject({
    toDismiss: 0, blockedAfterCutoff: 1,
  });
});

it("a Workpool job queued before the dismissal becomes a no-op", async () => {
  const h = await setup();
  const ids = await seedBacklog(h);
  const before = await h.delivery(ids.recent);
  await h.runMigration("dismissBlockedBacklog");
  await h.t.mutation(internal.pipeline.processor.processRawEvent, {
    rawEventId: before.row.rawEventId,
    generation: before.row.generation,
  });
  expect((await h.delivery(ids.recent)).row).toMatchObject({ status: "ignored", reason: DISMISSED_REASON });
});

it("restores selected deliveries to review, and the assertion still passes", async () => {
  const h = await setup();
  const ids = await seedBacklog(h);
  await h.runMigration("dismissBlockedBacklog");

  expect(
    await h.t.mutation(internal.pipeline.dismissal.restoreDismissedDeliveries, {
      deliveryIds: [ids.recent, ids.applied],
    }),
  ).toEqual({ restored: 1, skipped: 1 });
  const { row, raw, logs } = await h.delivery(ids.recent);
  expect(row).toMatchObject({ status: "blocked", reason: "ambiguous_booking_target", generation: 4 });
  expect(raw).toMatchObject({ processed: false });
  expect(raw?.processingReason).toBeUndefined();
  expect(logs[0].restoredAt).toBeDefined();

  expect((await h.runMigration("assertBlockedBacklogDismissed"))?.isDone).toBe(true);
  // Restoring twice is a no-op.
  expect(
    await h.t.mutation(internal.pipeline.dismissal.restoreDismissedDeliveries, { deliveryIds: [ids.recent] }),
  ).toEqual({ restored: 0, skipped: 1 });
});

it("raw cleanup deletes dismissed payloads older than retention and keeps recent ones", async () => {
  const h = await setup();
  const ids = await seedBacklog(h);
  await h.runMigration("dismissBlockedBacklog");
  await h.t.mutation(internal.webhooks.cleanupMutations.deleteExpiredEvents, {
    cutoffTimestamp: Date.now() - 30 * DAY,
  });
  expect((await h.delivery(ids.legacy)).raw).toBeNull();
  expect((await h.delivery(ids.recent)).raw).not.toBeNull();
  expect((await h.delivery(ids.legacy)).row).toMatchObject({ status: "ignored", reason: DISMISSED_REASON });
});
