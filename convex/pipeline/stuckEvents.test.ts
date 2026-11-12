import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import { reportError } from "../lib/observability/log";
import { buildBookingHealthIssues } from "../operations/bookingHealthCore";
import { adminCaller, seedAdminTenant } from "../../tests/mcpAdminFixtures";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { enqueueDelivery } from "./delivery";

vi.mock("../lib/observability/log", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/observability/log")>(),
  reportError: vi.fn(),
}));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STUCK = "pipeline.events_stuck_unprocessed";
const FAILED = "pipeline.deliveries_failed";
const HELD = "pipeline.held_bookings_waiting";
const RECEIPTLESS = "pipeline.raw_events_without_receipt";
const OLD = "pipeline.stuck_unprocessed_events";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.mocked(reportError).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function fixture() {
  const t = convexTest(schema, convexTestModules);
  const { tenantId, orgId } = await seedAdminTenant(t);
  let sequence = 0;
  const raw = async (receivedAt: number) => await t.run(async (ctx) => {
    sequence++;
    return await ctx.db.insert("rawWebhookEvents", {
      tenantId,
      eventType: "invitee.created",
      calendlyEventUri: `invitee-${sequence}`,
      payload: "PRIVATE PAYLOAD MUST NEVER BE LOGGED",
      receivedAt,
      processed: false,
    });
  });
  const receipt = async (
    status: Doc<"webhookDeliveries">["status"],
    receivedAt: number,
    queuedAt?: number,
    reason?: string,
  ) => {
    const rawEventId = await raw(receivedAt);
    return await t.run((ctx) => ctx.db.insert("webhookDeliveries", {
      tenantId,
      rawEventId,
      key: `delivery-${sequence}`,
      inviteeUri: `invitee-${sequence}`,
      eventType: "invitee.created",
      status,
      receivedAt,
      queuedAt,
      occurredAt: receivedAt,
      generation: 1,
      reason,
    }));
  };
  return { t, tenantId, orgId, raw, receipt };
}

function reports(event: string) {
  return vi.mocked(reportError).mock.calls.filter(([name]) => name === event);
}
function expectReport(event: string, attrs: Record<string, unknown>) {
  expect(reports(event)).toHaveLength(1);
  expect(reports(event)[0][2]).toMatchObject({ fingerprint: event, ...attrs });
  expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain("PRIVATE PAYLOAD");
}

it("does not alert every 15 minutes for held bookings alone", async () => {
  const f = await fixture();
  await f.receipt("blocked", Date.now() - 40 * DAY);
  await f.receipt("blocked", Date.now() - DAY);
  await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
  expect(reportError).not.toHaveBeenCalled();
});

it("finds a stale queued receipt behind 150 old holds", async () => {
  const f = await fixture();
  for (let i = 0; i < 150; i++) await f.receipt("blocked", Date.now() - 40 * DAY);
  await f.receipt("queued", Date.now() - 20 * MINUTE, Date.now() - 20 * MINUTE);
  await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
  expectReport(STUCK, { staleCount: 1, staleCountCapped: false, oldestAgeMs: 20 * MINUTE, tenantIds: [f.tenantId] });
});

it("uses the latest enqueue time instead of the original receipt time", async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++) {
    await f.receipt("queued", Date.now() - 40 * DAY, Date.now() - MINUTE);
  }
  await f.receipt("queued", Date.now() - 30 * MINUTE, Date.now() - 20 * MINUTE);
  await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
  expectReport(STUCK, { staleCount: 1, oldestAgeMs: 20 * MINUTE });
  const issues = await f.t.run((ctx) => buildBookingHealthIssues(ctx, f.tenantId));
  expect(issues).toHaveLength(1);
  expect(issues[0].severity).toBe("error");
});

it("keeps alerting failed receipts until they are retried", async () => {
  const f = await fixture();
  await f.receipt("failed", Date.now());
  for (let run = 0; run < 2; run++) {
    vi.mocked(reportError).mockClear();
    await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
    expectReport(FAILED, { severity: "error", staleCount: 1 });
    expect(reports(STUCK)).toHaveLength(0);
  }
});

it("reports legacy queued receipts using receivedAt", async () => {
  const f = await fixture();
  await f.receipt("queued", Date.now() - 20 * MINUTE);
  await f.receipt("queued", Date.now() - MINUTE);
  await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
  expectReport(STUCK, { staleCount: 1, oldestAgeMs: 20 * MINUTE });
});

it("does not let missing queuedAt values fill the numeric range", async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++) await f.receipt("queued", Date.now() - MINUTE);
  await f.receipt("queued", Date.now() - 20 * MINUTE, Date.now() - 20 * MINUTE);
  await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
  expectReport(STUCK, { staleCount: 1, oldestAgeMs: 20 * MINUTE });
});

it("caps watchdog counts and combines current and legacy stale receipts", async () => {
  const f = await fixture();
  for (let i = 0; i < 100; i++) {
    await f.receipt("queued", Date.now() - 20 * MINUTE, Date.now() - 20 * MINUTE);
  }
  await f.receipt("queued", Date.now() - DAY);
  await f.t.mutation(internal.pipeline.mutations.reportStuckEvents, {});
  expectReport(STUCK, { staleCount: 100, staleCountCapped: true, oldestAgeMs: DAY });
});

it("counts holds daily and finds a receiptless row beyond the first page", async () => {
  const f = await fixture();
  for (let i = 0; i < 150; i++) await f.receipt("blocked", Date.now() - 40 * DAY);
  await f.receipt("blocked", Date.now() - MINUTE);
  await f.raw(Date.now() - 2 * DAY);
  await f.t.action(internal.webhooks.cleanup.reportUnresolvedEvents, {});
  expectReport(HELD, { severity: "warning", count: 100, capped: true, oldestAgeMs: 40 * DAY, tenantIds: [f.tenantId] });
  expectReport(RECEIPTLESS, { severity: "error", staleCount: 1, oldestAgeMs: 2 * DAY });
  expect(reports(OLD)).toHaveLength(0);
});

it("continues after its page cap and reports a later receiptless row", async () => {
  const f = await fixture();
  for (let i = 0; i < 1025; i++) await f.receipt("blocked", Date.now() - 40 * DAY);
  await f.raw(Date.now() - DAY);
  await f.t.action(internal.webhooks.cleanup.reportUnresolvedEvents, {});
  expect(reports(RECEIPTLESS)).toHaveLength(0);
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expectReport(RECEIPTLESS, { staleCount: 1, oldestAgeMs: DAY });
  expect(reports(HELD)).toHaveLength(1);
  expect(reports(OLD)).toHaveLength(0);
});

it("skips held rows in the 30-day warning but retains other unresolved rows", async () => {
  const f = await fixture();
  await f.receipt("blocked", Date.now() - 45 * DAY);
  await f.receipt("failed", Date.now() - 35 * DAY);
  await f.raw(Date.now() - 31 * DAY);
  await f.t.action(internal.webhooks.cleanup.reportUnresolvedEvents, {});
  expectReport(OLD, { severity: "warning", staleCount: 2, oldestAgeMs: 35 * DAY });
  expectReport(RECEIPTLESS, { staleCount: 1, oldestAgeMs: 31 * DAY });
});

it.each([
  { status: "blocked", queuedAt: undefined, expected: "warning", reason: "bookings_held" },
  { status: "failed", queuedAt: undefined, expected: "error", reason: "delivery_failed" },
  { status: "queued", queuedAt: undefined, expected: "error", reason: "delivery_queued_too_long" },
  { status: "queued", queuedAt: () => Date.now() - 20 * MINUTE, expected: "error", reason: "delivery_queued_too_long" },
  { status: "queued", queuedAt: () => Date.now() - MINUTE, expected: "warning", reason: undefined },
] as const)("MCP health classifies $status as $expected", async ({ status, queuedAt, expected, reason }) => {
  const f = await fixture();
  await f.receipt(status, Date.now() - 40 * DAY, queuedAt?.(), "a_future_reason");
  const result = await f.t.query(internal.mcp.admin.reads.health.run, {
    caller: adminCaller(f.orgId),
    area: "booking_deliveries",
  });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].status).toBe(expected);
  expect(result.rows[0].reasonCodes).toEqual(reason ? [reason] : []);
  const web = f.t.withIdentity({ subject: "user_jordan", org_id: f.orgId });
  const issues = await web.query(api.operations.bookingHealth.listRecentBookingHealthIssues, {});
  expect(issues.length).toBe(reason ? 1 : 0);
  if (reason) expect(issues[0]).toMatchObject({ severity: expected });
});

it("stamps queuedAt on ingestion and refreshes it on requeue", async () => {
  const f = await fixture();
  workpool.register(f.t, "webhookWorkpool");
  const rawId = await f.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: f.tenantId,
    calendlyEventUri: "new-invitee",
    eventType: "event_type.updated",
    payload: "{}",
  });
  const original = await f.t.run((ctx) => ctx.db.query("webhookDeliveries")
    .withIndex("by_rawEventId", (q) => q.eq("rawEventId", rawId!)).unique());
  expect(original).toMatchObject({ status: "queued", queuedAt: Date.now() });
  vi.setSystemTime(Date.now() + MINUTE);
  await f.t.run((ctx) => enqueueDelivery(ctx, original!._id));
  const requeued = await f.t.run((ctx) => ctx.db.get("webhookDeliveries", original!._id));
  expect(requeued).toMatchObject({ status: "queued", queuedAt: Date.now(), generation: original!.generation + 1 });
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
});
