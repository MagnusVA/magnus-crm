import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload, mapEventTypeToProgram } from "../../tests/bookingHarness";
import { book, enrollmentHarness } from "../../tests/enrollmentFixtures";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import { WEB } from "../lib/outcomeCores";
import { retryDeliveryCore } from "./recovery";
import { retryProjectionCore } from "../operations/workStatus";

// The delivery and projection retries split into a guard and a core (admin
// assistant, commit 9). The web snapshots were taken on the handlers before
// the split.

afterEach(() => vi.useRealTimers());

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const WRITE_AT = Date.parse("2026-10-21T09:00:00Z");

/**
 * The rows `write` adds or changes, at a fixed time. Workpool IDs depend on
 * how many jobs the component ran before, so they are masked.
 */
async function writes(harness: { t: Harness["t"] }, write: () => Promise<unknown>) {
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(new Date(WRITE_AT));
  const before = await dumpTables(harness.t);
  const result = await write();
  const after = await dumpTables(harness.t);
  const written = JSON.parse(
    JSON.stringify(writtenRows(before, after)).replace(/"workId":"[^"]+"/g, '"workId":"<work>"'),
  ) as ReturnType<typeof writtenRows>;
  return { result, written };
}

/** A booking blocked because its host isn't linked, then the host added. */
async function blockedDelivery() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
  const harness = await bookingHarness();
  const { t, tenantId, admin } = harness;
  const payload = bookingPayload("unlinked");
  await t.run((ctx) => mapEventTypeToProgram(ctx, tenantId, payload.scheduled_event.event_type));
  payload.scheduled_event.event_memberships[0].user = "https://api.calendly.com/users/new-host";
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const { page } = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
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
  const adminId = await t.run(async (ctx) =>
    (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
      .unique())!._id,
  );
  const actor = { userId: adminId, tenantId, role: "tenant_admin" as const };
  return { ...harness, deliveryId: page[0]._id as Id<"webhookDeliveries">, generation: page[0].generation, actor };
}

async function failedProjection() {
  const harness = await enrollmentHarness();
  const deal = await book(harness, "projection");
  const projectionId = await harness.t.run(async (ctx) => {
    const row = (await ctx.db
      .query("meetingProjections")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", deal.meetingId))
      .unique())!;
    await ctx.db.patch("meetingProjections", row._id, { status: "failed", reason: "boom" });
    return row._id;
  });
  const generation = await harness.t.run(async (ctx) => (await ctx.db.get("meetingProjections", projectionId))!.generation);
  const actor = { userId: harness.adminId, tenantId: harness.tenantId, role: "tenant_admin" as const };
  return { ...harness, projectionId, generation, actor };
}

describe("web paths write what they wrote before the split", () => {
  it("recovery.retry", async () => {
    const f = await blockedDelivery();
    const manifest = await f.admin.query(api.pipeline.recovery.preview, { deliveryIds: [f.deliveryId] });
    const { written } = await writes(f, () => f.admin.mutation(api.pipeline.recovery.retry, { manifest }));
    expect(written).toMatchSnapshot();
    await expect(f.admin.mutation(api.pipeline.recovery.retry, { manifest })).rejects.toThrow(
      "Recovery preview is stale",
    );
  });

  it("workStatus.retry", async () => {
    const f = await failedProjection();
    const { written } = await writes(f, () =>
      f.admin.mutation(api.operations.workStatus.retry, {
        kind: "meeting",
        id: f.projectionId,
        generation: f.generation,
      }),
    );
    expect(written).toMatchSnapshot();
    await expect(
      f.admin.mutation(api.operations.workStatus.retry, {
        kind: "meeting",
        id: f.projectionId,
        generation: f.generation,
      }),
    ).rejects.toThrow("Projection retry is stale or work has not failed");
  });
});

describe("cores", () => {
  it("retryDeliveryCore writes what the web retry writes, and refuses a stale generation", async () => {
    const web = await blockedDelivery();
    const manifest = await web.admin.query(api.pipeline.recovery.preview, { deliveryIds: [web.deliveryId] });
    const webWrites = await writes(web, () => web.admin.mutation(api.pipeline.recovery.retry, { manifest }));

    const mcp = await blockedDelivery();
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) =>
        retryDeliveryCore(ctx, mcp.actor, { deliveryId: mcp.deliveryId, generation: mcp.generation }, MCP),
      ),
    );
    expect(mcpWrites.written).toEqual(webWrites.written);
    await expect(
      mcp.t.run((ctx) =>
        retryDeliveryCore(ctx, mcp.actor, { deliveryId: mcp.deliveryId, generation: mcp.generation }, WEB),
      ),
    ).rejects.toThrow("Recovery preview is stale");
  });

  it("retryDeliveryCore refuses a closer", async () => {
    const f = await blockedDelivery();
    await expect(
      f.t.run((ctx) =>
        retryDeliveryCore(
          ctx,
          { ...f.actor, role: "closer" },
          { deliveryId: f.deliveryId, generation: f.generation },
          MCP,
        ),
      ),
    ).rejects.toThrow("This action isn't available for your role.");
  });

  it("retryProjectionCore writes what the web retry writes", async () => {
    const web = await failedProjection();
    const webWrites = await writes(web, () =>
      web.admin.mutation(api.operations.workStatus.retry, {
        kind: "meeting",
        id: web.projectionId,
        generation: web.generation,
      }),
    );
    const mcp = await failedProjection();
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) =>
        retryProjectionCore(
          ctx,
          mcp.actor,
          { kind: "meeting", id: mcp.projectionId, generation: mcp.generation },
          MCP,
        ),
      ),
    );
    expect(mcpWrites.written).toEqual(webWrites.written);
  });
});
