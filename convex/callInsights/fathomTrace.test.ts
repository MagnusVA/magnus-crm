import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import {
  callInsightsHarness,
  gatewayFetch,
} from "../../tests/callInsightsHarness";
import { queueRead } from "./trigger";

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function droppedEvent(ignored: boolean) {
  const f = await callInsightsHarness({ settings: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  const recording = await f.t.run((ctx) =>
    ctx.db.get("callRecordings", f.recordingId),
  );
  if (!recording) throw new Error("Missing recording");
  await f.t.run((ctx) =>
    ctx.db.insert("fathomOrgMembers", {
      tenantId: f.tenantId,
      email: "kim@example.com",
      matchedUserId: f.closerId,
      ignored,
      lastSyncedAt: Date.now(),
    }),
  );
  const start = Date.now() - 60 * 60_000;
  const end = Date.now();
  // Both cases are internal-only. An ignored recorder must still keep no trace.
  const data = {
    recording_id: 42,
    title: "Internal call",
    meeting_title: "Internal",
    url: "https://fathom.video/calls/42",
    share_url: "https://fathom.video/share/42",
    recorded_by: { email: " Kim@Example.com " },
    recording_start_time: new Date(start).toISOString(),
    recording_end_time: new Date(end).toISOString(),
    scheduled_start_time: new Date(start).toISOString(),
    scheduled_end_time: new Date(end).toISOString(),
    calendar_invitees_domains_type: "only_internal",
    calendar_invitees: [{ email: "kim@example.com", is_external: false }],
    transcript: [],
    default_summary: null,
    action_items: [],
  };
  const eventId = await f.t.run(async (ctx) => {
    const payloadStorageId = await ctx.storage.store(
      new Blob([JSON.stringify(data)]),
    );
    return await ctx.db.insert("fathomWebhookEvents", {
      tenantId: f.tenantId,
      connectionId: recording.connectionId,
      webhookMessageId: "trace-event",
      receivedAt: Date.now(),
      status: "pending",
      payload: "",
      payloadStorageId,
    });
  });
  await f.t.action(internal.fathom.processor.process, { eventId });
  return { ...f, eventId, start, end };
}

describe("dropped recording traces", () => {
  it("passes recording times from process and keeps them only for internal-only drops", async () => {
    const f = await droppedEvent(false);
    const event = await f.t.run((ctx) =>
      ctx.db.get("fathomWebhookEvents", f.eventId),
    );
    expect(event).toMatchObject({
      status: "dropped",
      payload: "",
      droppedRecordedByEmail: "kim@example.com",
      droppedRecordingStartAt: f.start,
      droppedRecordingEndAt: f.end,
    });
    expect(event?.payloadStorageId).toBeUndefined();
    expect(
      await f.t.run((ctx) => ctx.db.query("callRecordings").take(10)),
    ).toHaveLength(1);
    vi.setSystemTime(f.end + 7 * 86_400_000 + 1);
    await f.t.mutation(internal.fathom.maintenance.purge, {});
    expect(
      await f.t.run((ctx) => ctx.db.get("fathomWebhookEvents", f.eventId)),
    ).toBeNull();
  });

  it("keeps no trace for an ignored member, even on an internal-only recording", async () => {
    const f = await droppedEvent(true);
    const event = await f.t.run((ctx) =>
      ctx.db.get("fathomWebhookEvents", f.eventId),
    );
    expect(event).toMatchObject({ status: "dropped", payload: "" });
    for (const key of [
      "droppedRecordedByEmail",
      "droppedRecordingStartAt",
      "droppedRecordingEndAt",
    ] as const)
      expect(event?.[key]).toBeUndefined();
  });

  it("accepts older classify calls without recording times", async () => {
    const f = await droppedEvent(false);
    await f.t.run((ctx) =>
      ctx.db.patch("fathomWebhookEvents", f.eventId, {
        status: "pending",
        droppedRecordedByEmail: undefined,
        droppedRecordingStartAt: undefined,
        droppedRecordingEndAt: undefined,
      }),
    );
    await f.t.mutation(internal.fathom.processor.classify, {
      eventId: f.eventId,
      email: "kim@example.com",
      hasExternalInvitee: false,
    });
    expect(
      await f.t.run((ctx) => ctx.db.get("fathomWebhookEvents", f.eventId)),
    ).toMatchObject({
      status: "dropped",
      droppedRecordedByEmail: "kim@example.com",
    });
  });
});

describe("transcript retention", () => {
  it.each(["expires_at", "legacy"] as const)(
    "schedules quote purging when the %s retention path deletes a transcript",
    async (path) => {
      const f = await callInsightsHarness({ settings: { suggestions: "on" } });
      vi.stubGlobal("fetch", vi.fn(gatewayFetch().fetchImpl));
      await f.t.run((ctx) =>
        queueRead(ctx, {
          recordingId: f.recordingId,
          trigger: "recording_matched",
        }),
      );
      await f.t.finishAllScheduledFunctions(vi.runAllTimers);
      const run = await f.t.run((ctx) =>
        ctx.db.query("callInsightRuns").take(1),
      );
      expect(run[0].items?.some((item) => item.quote.length > 0)).toBe(true);
      const storageId = await f.t.run(async (ctx) => {
        const recording = await ctx.db.get("callRecordings", f.recordingId);
        if (!recording?.transcriptStorageId)
          throw new Error("Missing transcript");
        await ctx.db.patch(
          "callRecordings",
          f.recordingId,
          path === "legacy"
            ? {
                transcriptExpiresAt: undefined,
                createdAt: Date.now() - 91 * 86_400_000,
              }
            : { transcriptExpiresAt: Date.now() - 1 },
        );
        return recording.transcriptStorageId;
      });
      await f.t.mutation(internal.fathom.maintenance.purge, {});
      expect(await f.t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
      expect(
        await f.t.run((ctx) => ctx.db.get("callRecordings", f.recordingId)),
      ).toMatchObject({ transcriptDeletedAt: Date.now() });
      const scheduled = await f.t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").take(100),
      );
      expect(
        scheduled.some(
          (job) =>
            job.name === "callInsights/maintenance:purgeRecording" &&
            job.args[0]?.recordingId === f.recordingId,
        ),
      ).toBe(true);
      await f.t.finishAllScheduledFunctions(vi.runAllTimers);
      const purged = await f.t.run((ctx) =>
        ctx.db.get("callInsightRuns", run[0]._id),
      );
      expect(purged?.quotesPurgedAt).toBeDefined();
      expect(
        purged?.items?.map((item) => [
          item.category,
          item.statement,
          item.quote,
        ]),
      ).toEqual([
        ["partner", "", ""],
        ["personal_income", "", ""],
      ]);
      expect(purged?.result?.quotes.length).toBeGreaterThan(0);
      expect(purged?.result?.quotes.every((quote) => quote.quote === "")).toBe(
        true,
      );
      const state = await f.t.run((ctx) =>
        ctx.db
          .query("resultSuggestionStates")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", f.meetingId))
          .first(),
      );
      expect(state?.quotes.every((quote) => quote.quote === "")).toBe(true);
      expect(state?.quotesPurgedAt).toBeDefined();
    },
  );
});
