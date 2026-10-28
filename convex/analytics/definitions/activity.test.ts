import { describe, expect, it } from "vitest";
import { bookingHarness } from "../../../tests/bookingHarness";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { api } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { insertActivityEventCounts } from "../../reporting/activityEventCounts";

const identity = { subject: "user_admin", org_id: "org_test" };
const range = {
  startDate: "2026-10-01",
  endDateInclusive: "2026-10-31",
  fromMs: Date.parse("2026-10-01T06:00:00Z"),
  toMs: Date.parse("2026-11-01T06:00:00Z"),
  timeZone: "America/Tegucigalpa",
  dayStartHour: 0,
};
const AT = Date.parse("2026-10-10T12:00:00Z");

async function createFixture() {
  const harness = await bookingHarness();
  await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    // The summary reads the aggregate once it is verified, as production does.
    await ctx.db.patch("tenants", tenantId, { activityEventCountsVerifiedAt: 0 });
    const users = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(10);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const closerId = users.find((user) => user.role === "closer")!._id;
    const removedId = await ctx.db.insert("users", {
      tenantId, workosUserId: "user_gone", email: "gone@example.com", role: "closer", isActive: false,
    });
    const event = async (fields: Partial<Doc<"domainEvents">>) => {
      const id = await ctx.db.insert("domainEvents", {
        tenantId, entityType: "meeting", entityId: "m1", eventType: "meeting.started", source: "closer", occurredAt: AT, ...fields,
      });
      await insertActivityEventCounts(ctx, (await ctx.db.get("domainEvents", id))!);
    };
    await event({ actorUserId: closerId });
    await event({ actorUserId: closerId, eventType: "meeting.completed" });
    await event({ actorUserId: adminId, source: "admin", entityType: "payment", eventType: "payment.recorded" });
    await event({ source: "system", entityType: "opportunity", eventType: "opportunity.stale_flagged" });
    await event({ actorUserId: closerId, entityType: "followUp", eventType: "followUp.completed", metadata: JSON.stringify({ outcome: "payment_received" }) });
    await event({ actorUserId: closerId, entityType: "followUp", eventType: "followUp.completed", metadata: "{not json" });
    await event({ actorUserId: removedId, eventType: "meeting.legacy_type" });
    // Outside the range.
    await event({ actorUserId: adminId, occurredAt: range.toMs });
    await ctx.db.delete("users", removedId);
  });
  return harness;
}

// What the summary SQL returns: one count per dimension value, as
// activityEventDimensions keys the aggregate entries.
async function summaryRows(ctx: MutationCtx) {
  const counts = new Map<string, { dimension: string; value: string; count: number }>();
  const add = (dimension: string, value: string) => {
    const key = JSON.stringify([dimension, value]);
    counts.set(key, { dimension, value, count: (counts.get(key)?.count ?? 0) + 1 });
  };
  for (const event of await ctx.db.query("domainEvents").take(100)) {
    if (event.occurredAt < range.fromMs || event.occurredAt >= range.toMs) continue;
    add("all", "");
    add("source", event.source ?? "");
    add("entityType", event.entityType);
    add("eventType", event.eventType);
    add("actor", event.actorUserId ?? "");
    if (event.eventType === "followUp.completed") {
      try {
        const outcome = (JSON.parse(event.metadata ?? "null") as { outcome?: unknown } | null)?.outcome;
        if (typeof outcome === "string") add("reminderOutcome", `reminder_${outcome}`);
      } catch {
        // No outcome, as in the SQL.
      }
    }
  }
  return { counts: [...counts.values()] };
}

describe("Activity summary from ClickHouse rows", () => {
  it("matches the aggregate summary, a removed user and an unlisted event type included", async () => {
    const { t, tenantId } = await createFixture();
    const live = await expectSameAnswer({
      t, identity, tenantId, range,
      rows: await t.run(summaryRows),
      reportId: "activity.summary",
      live: api.reporting.activityFeed.getActivitySummary,
      liveArgs: { startDate: range.fromMs, endDate: range.toMs },
      filters: {},
    });
    expect(live).toMatchObject({
      totalEvents: 7,
      byOutcome: { reminder_payment_received: 1 },
      byActor: { removed: 1 },
    });
    expect(live.byEventType["meeting.legacy_type"]).toBe(1);
  });
});
