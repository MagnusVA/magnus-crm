import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServiceToken } from "convex/server";
import { api, internal } from "../_generated/api";
import { onRecordingMatched } from "../fathom/recordings";
import {
  secondOpinionHarness,
  decisionsResponse,
} from "../../tests/secondOpinionHarness";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { businessDayRange } from "../../lib/businessDay";
import { buildState, labelSpeakers } from "./transcript";
import { secondOpinionFor } from "../mcp/tools/today";

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
  vi.mocked(getServiceToken).mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const row = (
  f: Awaited<ReturnType<typeof secondOpinionHarness>>,
  id: Id<"secondOpinions">,
) => f.t.run((ctx) => ctx.db.get("secondOpinions", id));
const response = (status = 200, body: unknown = decisionsResponse()) =>
  new Response(JSON.stringify(body), { status });
const scheduledRows = (f: Awaited<ReturnType<typeof secondOpinionHarness>>) =>
  f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(500));

async function answered(
  mode: "off" | "shadow" | "on" = "on",
  status: Doc<"meetings">["status"] = "no_show",
) {
  const f = await secondOpinionHarness(mode, status);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
  const id = await f.queue();
  if (!id) throw new Error("No check queued");
  await f.t.action(internal.secondOpinion.run.run, {
    secondOpinionId: id,
    attempt: 0,
  });
  return { ...f, id };
}

describe("queueSecondOpinion", () => {
  it.each(["off", null] as const)("does nothing with mode %s", async (mode) => {
    const f = await secondOpinionHarness(mode);
    expect(await f.queue()).toBeNull();
    expect(await scheduledRows(f)).toHaveLength(0);
  });
  it("needs both a result and a matched, retained transcript", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    expect(await f.queue()).toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, { status: "held" }),
    );
    await f.patchDeal({ stage: "follow_up" });
    // The call-back this meeting's result set.
    await f.t.run((ctx) =>
      ctx.db.insert("followUps", {
        tenantId: f.tenantId,
        opportunityId: f.opportunityId,
        leadId: f.leadId,
        closerId: f.closerId,
        type: "manual_reminder",
        sourceMeetingId: f.meetingId,
        reminderScheduledAt: Date.now() + 86400_000,
        reason: "closer_initiated",
        status: "pending",
        createdAt: Date.now(),
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptStorageId: undefined,
      }),
    );
    expect(await f.queue()).toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptStorageId: f.transcriptStorageId,
        matchStatus: "unmatched",
      }),
    );
    expect(await f.queue()).toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, { matchStatus: "matched" }),
    );
    const id = await f.queue("recording_matched");
    expect(id).not.toBeNull();
    expect((await row(f, id!))?.record).toEqual({ kind: "call_back" });
  });
  it("the Fathom hook queues exactly once and snapshots no-show", async () => {
    const f = await secondOpinionHarness();
    await f.t.run((ctx) =>
      onRecordingMatched(ctx, {
        meetingId: f.meetingId,
        recordingId: f.recordingId,
      }),
    );
    expect(await f.queue()).toBeNull();
    const rows = await f.t.run((ctx) =>
      ctx.db.query("secondOpinions").take(500),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: "recording_matched",
      record: { kind: "no_show" },
      claim: "The prospect never joined the call.",
      attempts: 0,
      status: "queued",
    });
    expect(await scheduledRows(f)).toHaveLength(1);
  });
  it("snapshots the deal payment including type, amount and currency", async () => {
    const f = await secondOpinionHarness("on", "held");
    await f.t.run(async (ctx) => {
      const programId = await ctx.db.insert("tenantPrograms", {
        tenantId: f.tenantId,
        name: "Scale",
        normalizedName: "scale",
        createdByUserId: f.ownerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId,
        opportunityId: f.opportunityId,
        meetingId: f.meetingId,
        amountMinor: 450000,
        currency: "USD",
        paymentType: "pif",
        recordedByUserId: f.closerId,
        programId,
        programName: "Scale",
        status: "recorded",
        recordedAt: Date.now(),
        origin: "closer_meeting",
      });
    });
    const id = await f.queue();
    expect((await row(f, id!))?.record).toEqual({
      kind: "payment",
      amountMinor: 450000,
      currency: "USD",
      paymentType: "pif",
    });
  });
  it("snapshots a loss reason", async () => {
    const f = await secondOpinionHarness("on", "held");
    // A meeting's loss writes lostAt with the meeting's heldMarkedAt.
    const at = Date.now();
    await f.t.run((ctx) => ctx.db.patch("meetings", f.meetingId, { heldMarkedAt: at }));
    await f.patchDeal({
      stage: "closed",
      outcome: "lost",
      lostReason: "price",
      lostAt: at,
    });
    const id = await f.queue();
    expect((await row(f, id!))?.record).toEqual({
      kind: "lost",
      lossReason: "price",
    });
  });
  it("a day-close hint consumes the check even after a later result", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    expect(await f.queue("day_closed")).toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, {
        scheduledAt: Date.now() - 86400_000,
      }),
    );
    const id = await f.queue("day_closed");
    expect((await row(f, id!))?.record).toBeUndefined();
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, { status: "held" }),
    );
    expect(await f.queue()).toBeNull();
  });
});

describe("Decisions run", () => {
  it("stores a disagreement, usage and measured evidence without modifying any business records", async () => {
    const f = await secondOpinionHarness();
    const tables = Object.keys(schema.tables).filter(
      (table) => table !== "secondOpinions",
    ) as TableNames[];
    const snapshot = () =>
      f.t.run(async (ctx) =>
        Promise.all(tables.map((table) => ctx.db.query(table).take(500))),
      );
    const before = await snapshot();
    const fetchStub = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", fetchStub);
    const id = await f.queue();
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    expect(await snapshot()).toEqual(before);
    expect(await row(f, id!)).toMatchObject({
      status: "answered",
      verdict: "disagrees",
      reviewState: "open",
      attempts: 1,
      // Three question groups, each read with and without Fathom's summary.
      calls: 6,
      split: [],
      costUsd: expect.closeTo(0.0187 * 6, 10),
      gatewayRequestId: "gateway-test",
      inputTokens: 8210 * 6,
      evidence: {
        recordedMinutes: 34,
        prospectFirstAt: Date.now() - 2 * 3600_000 + 11 * 60_000,
      },
    });
    const requests = fetchStub.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    const request = requests[0];
    expect(request.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(
      request.state.transcript.map((line: { speaker: string }) => line.speaker),
    ).toEqual(["Closer", "Prospect", "Closer", "Other"]);
    expect(request.state.fathomSummary).toBe("Grace asked to talk again.");
    expect(request.state.actionItems).toEqual(["Call tomorrow"]);
    // Each call asks one group of questions; the second reading has no summary.
    expect(requests.map((r) => Object.keys(r.questions).join("+"))).toEqual([
      "attendance",
      "ending+objection",
      "claim",
      "attendance",
      "ending+objection",
      "claim",
    ]);
    expect(requests.slice(3).every((r) => r.state.fathomSummary === undefined)).toBe(true);
    expect(requests.slice(3).every((r) => r.state.actionItems === undefined)).toBe(true);
    expect(getServiceToken).toHaveBeenCalledTimes(6);
    expect(vi.mocked(getServiceToken).mock.calls.every(([name]) => name === "ai-gateway")).toBe(true);
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });
  it("skips at the monthly cap without a gateway token or request", async () => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    const original = await row(f, id!);
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...data } = original!;
      void _id;
      void _creationTime;
      await ctx.db.insert("secondOpinions", {
        ...data,
        inputKey: "previous",
        status: "answered",
        costUsd: 40,
      });
    });
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    expect(await row(f, id!)).toMatchObject({
      status: "skipped",
      failure: "cap_reached",
      attempts: 0,
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(getServiceToken).not.toHaveBeenCalled();
  });
  it("retries a 503 after one minute then saves a 200", async () => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    const fetchStub = vi
      .fn(async () => response())
      .mockResolvedValueOnce(response(503));
    vi.stubGlobal("fetch", fetchStub);
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    const scheduled = await scheduledRows(f);
    expect(
      scheduled.some((job) => job.scheduledTime === Date.now() + 60_000),
    ).toBe(true);
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await row(f, id!)).toMatchObject({
      status: "answered",
      attempts: 2,
      // The five calls that answered on the first attempt still count.
      costUsd: expect.closeTo(0.0187 * 11, 10),
    });
    expect(fetchStub).toHaveBeenCalledTimes(12);
    expect(getServiceToken).toHaveBeenCalledTimes(12);
  });
  it("fails after three upstream failures, with one and five minute backoffs", async () => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    const fetchStub = vi.fn(async () => response(503));
    vi.stubGlobal("fetch", fetchStub);
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 1,
    });
    expect(
      (await scheduledRows(f)).some(
        (job) => job.scheduledTime === Date.now() + 300_000,
      ),
    ).toBe(true);
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await row(f, id!)).toMatchObject({
      status: "failed",
      failure: "upstream_error",
      attempts: 3,
    });
    expect(fetchStub).toHaveBeenCalledTimes(18);
  });
  it.each([
    [400, "rejected"],
    [200, "format_changed"],
  ] as const)("does not retry %s (%s)", async (status, failure) => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    const fetchStub = vi.fn(async () => response(status, { answers: {} }));
    vi.stubGlobal("fetch", fetchStub);
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await row(f, id!)).toMatchObject({
      status: "failed",
      failure,
      attempts: 1,
    });
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });
  it("rechecks consent and transcript retention before sending", async () => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    await f.owner.mutation(api.secondOpinion.setMode, {
      mode: "off",
      monthlyCapUsd: 40,
    });
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    expect(await row(f, id!)).toMatchObject({
      status: "skipped",
      failure: "disabled",
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("visibility, notes and review", () => {
  it.each(["on", "shadow", "off"] as const)(
    "applies mode %s to closer, admin and owner",
    async (mode) => {
      const f = await answered();
      await f.t.run(async (ctx) => {
        const tenant = await ctx.db.get("tenants", f.tenantId);
        await ctx.db.patch("tenants", f.tenantId, {
          secondOpinion: { ...tenant!.secondOpinion!, mode },
        });
      });
      expect(
        Boolean(
          await f.closer.query(api.secondOpinion.forMeeting, {
            meetingId: f.meetingId,
          }),
        ),
      ).toBe(mode === "on");
      // Admins work the queue during the shadow run; closers wait for "on".
      expect(
        Boolean(
          await f.admin.query(api.secondOpinion.getForReview, {
            secondOpinionId: f.id,
          }),
        ),
      ).toBe(mode !== "off");
      expect(
        Boolean(
          await f.owner.query(api.secondOpinion.forMeeting, {
            meetingId: f.meetingId,
          }),
        ),
      ).toBe(mode !== "off");
      expect(
        await f.other.query(api.secondOpinion.forMeeting, {
          meetingId: f.meetingId,
        }),
      ).toBeNull();
      const queue = await f.admin.query(api.secondOpinion.listForReview, {
        tab: "disagrees",
        paginationOpts: { numItems: 25, cursor: null },
      });
      expect(queue.page).toHaveLength(mode !== "off" ? 1 : 0);
      const settings = await f.admin.query(api.secondOpinion.getSettings, {});
      expect(settings.month.answered).toBe(mode !== "off" ? 1 : 0);
    },
  );
  it("hides a closer's card before recording and keeps the MCP contract", async () => {
    const f = await answered();
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, { status: "scheduled" }),
    );
    expect(
      await f.closer.query(api.secondOpinion.forMeeting, {
        meetingId: f.meetingId,
      }),
    ).toBeNull();
    expect(
      await f.admin.query(api.secondOpinion.forMeeting, {
        meetingId: f.meetingId,
      }),
    ).not.toBeNull();
    // The existing MCP reader independently requires a recorded result.
    const readAgent = () =>
      f.t.run(async (ctx) => {
        const tenant = await ctx.db.get("tenants", f.tenantId);
        const user = await ctx.db.get("users", f.closerId);
        const meeting = await ctx.db.get("meetings", f.meetingId);
        return secondOpinionFor(
          ctx,
          {
            tenant: tenant!,
            user: user!,
            userId: f.closerId,
            tenantId: f.tenantId,
            role: "closer",
            workosUserId: "user_closer",
            agentClient: "test",
            timeZone: "America/Tegucigalpa",
          },
          meeting!,
        );
      });
    expect(await readAgent()).toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, { status: "no_show" }),
    );
    expect(await readAgent()).toMatchObject({
      verdict: "disagrees",
      heard: { attendance: "held" },
    });
  });
  it("shows a hint only after the business day closes, including after a later result", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, {
        scheduledAt: Date.now() - 86400_000,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const id = await f.queue("day_closed");
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    expect(
      (
        await f.closer.query(api.secondOpinion.forMeeting, {
          meetingId: f.meetingId,
        })
      )?.opinion.verdict,
    ).toBe("hint");
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, { status: "held" }),
    );
    expect(
      (
        await f.closer.query(api.secondOpinion.forMeeting, {
          meetingId: f.meetingId,
        })
      )?.opinion.verdict,
    ).toBe("hint");
  });
  it("allows only the meeting's closer to add one note", async () => {
    const f = await answered();
    await expect(
      f.other.mutation(api.secondOpinion.addCloserNote, {
        secondOpinionId: f.id,
        note: "Other",
      }),
    ).rejects.toThrow();
    await expect(
      f.admin.mutation(api.secondOpinion.addCloserNote, {
        secondOpinionId: f.id,
        note: "Admin",
      }),
    ).rejects.toThrow();
    await f.closer.mutation(api.secondOpinion.addCloserNote, {
      secondOpinionId: f.id,
      note: " I waited ten minutes. ",
    });
    expect((await row(f, f.id))?.closerNote).toBe("I waited ten minutes.");
    await expect(
      f.closer.mutation(api.secondOpinion.addCloserNote, {
        secondOpinionId: f.id,
        note: "Again",
      }),
    ).rejects.toThrow();
  });
  it("checks without changing the record, then refuses a second check", async () => {
    const f = await answered();
    const before = await f.t.run((ctx) =>
      ctx.db.get("opportunities", f.opportunityId),
    );
    await f.admin.mutation(api.secondOpinion.check, {
      secondOpinionId: f.id,
      outcome: "closer_right",
    });
    expect(
      await f.t.run((ctx) => ctx.db.get("opportunities", f.opportunityId)),
    ).toEqual(before);
    expect(await row(f, f.id)).toMatchObject({
      reviewState: "checked",
      review: { outcome: "closer_right", reopened: false },
    });
    await expect(
      f.admin.mutation(api.secondOpinion.check, {
        secondOpinionId: f.id,
        outcome: "second_opinion_right",
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.admin.query(api.secondOpinion.listForReview, {
          tab: "disagrees",
          paginationOpts: { numItems: 25, cursor: null },
        })
      ).page,
    ).toHaveLength(0);
    expect(
      (
        await f.admin.query(api.secondOpinion.listForReview, {
          tab: "checked",
          paginationOpts: { numItems: 25, cursor: null },
        })
      ).page,
    ).toHaveLength(1);
  });
  it("reopens through the admin core, at Follow-up with a call-back, leaving attendance no-show", async () => {
    const f = await answered();
    // Rebuild the strict aggregates the review's existing admin path writes.
    const { insertOpportunityAggregate } =
      await import("../reporting/writeHooks");
    await f.t.run(async (ctx) => {
      const deal = await ctx.db.get("opportunities", f.opportunityId);
      await insertOpportunityAggregate(ctx, deal!._id);
    });
    await f.admin.mutation(api.secondOpinion.check, {
      secondOpinionId: f.id,
      outcome: "second_opinion_right",
      reopen: { date: "2026-11-06", time: "10:00" },
    });
    const after = await f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.opportunityId),
      meeting: await ctx.db.get("meetings", f.meetingId),
      tasks: await ctx.db.query("followUps").take(500),
      events: await ctx.db.query("domainEvents").take(500),
    }));
    expect(after.deal).toMatchObject({ stage: "follow_up", outcome: "open" });
    expect(after.meeting?.status).toBe("no_show");
    expect(after.meeting?.heldMarkedAt).toBeUndefined();
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0]).toMatchObject({
      type: "manual_reminder",
      contactMethod: "call",
      closerId: f.closerId,
      sourceMeetingId: f.meetingId,
      reason: "no_show_follow_up",
      reminderScheduledAt: Date.parse("2026-11-06T16:00:00Z"),
    });
    expect(
      after.events.some(
        (event) => event.eventType === "opportunity.stage_changed",
      ),
    ).toBe(true);
    expect(await row(f, f.id)).toMatchObject({ review: { reopened: true } });
  });
  it("does not leak or mutate across tenants", async () => {
    const f = await answered();
    const outsider = await f.t.run(async (ctx) => {
      const tenantId = await ctx.db.insert("tenants", {
        companyName: "Other",
        contactEmail: "other@x.com",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      return ctx.db.insert("users", {
        tenantId,
        workosUserId: "user_outside",
        email: "outside@x.com",
        role: "tenant_master",
        isActive: true,
      });
    });
    void outsider;
    const other = f.t.withIdentity({
      subject: "user_outside",
      org_id: "org_other",
    });
    expect(
      await other.query(api.secondOpinion.getForReview, {
        secondOpinionId: f.id,
      }),
    ).toBeNull();
    await expect(
      other.mutation(api.secondOpinion.check, {
        secondOpinionId: f.id,
        outcome: "closer_right",
      }),
    ).rejects.toThrow();
    await expect(
      f.closer.query(api.secondOpinion.listForReview, {
        tab: "all",
        paginationOpts: { numItems: 25, cursor: null },
      }),
    ).rejects.toThrow();
  });
});

describe("settings and day-close sweep", () => {
  it("requires an owner, starts shadow for 14 days and never opens automatically", async () => {
    const f = await secondOpinionHarness(null);
    await expect(
      f.admin.mutation(api.secondOpinion.setMode, {
        mode: "on",
        monthlyCapUsd: 40,
      }),
    ).rejects.toThrow();
    await f.owner.mutation(api.secondOpinion.setMode, {
      mode: "on",
      monthlyCapUsd: 40,
    });
    expect(
      await f.owner.query(api.secondOpinion.getSettings, {}),
    ).toMatchObject({ mode: "shadow", shadowDay: 1, readyToOpen: false });
    await expect(
      f.owner.mutation(api.secondOpinion.setMode, {
        mode: "on",
        monthlyCapUsd: 40,
      }),
    ).rejects.toThrow();
    vi.setSystemTime(Date.now() + 14 * 86400_000);
    expect(
      await f.owner.query(api.secondOpinion.getSettings, {}),
    ).toMatchObject({ mode: "shadow", shadowDay: 14, readyToOpen: true });
    await f.owner.mutation(api.secondOpinion.setMode, {
      mode: "on",
      monthlyCapUsd: 80,
    });
    expect(
      await f.owner.query(api.secondOpinion.getSettings, {}),
    ).toMatchObject({ mode: "on", monthlyCapUsd: 80 });
  });
  it("queues only yesterday's still-unrecorded meetings when its business day closed within the hour", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    const day = businessDayRange("2026-11-02");
    vi.setSystemTime(day.end + 30 * 60_000);
    await f.t.run((ctx) =>
      ctx.db.patch("meetings", f.meetingId, {
        scheduledAt: day.start + 3600_000,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    await f.t.mutation(internal.secondOpinion.sweep.run, {});
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const opinions = await f.t.run((ctx) =>
      ctx.db.query("secondOpinions").take(500),
    );
    expect(opinions).toHaveLength(1);
    expect(opinions[0]).toMatchObject({
      trigger: "day_closed",
      verdict: "hint",
      status: "answered",
    });
    await f.t.mutation(internal.secondOpinion.sweep.run, {});
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await f.t.run((ctx) => ctx.db.query("secondOpinions").take(500)),
    ).toHaveLength(1);
  });
  it("doesn't schedule day checks outside the last hour's close", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    await f.t.mutation(internal.secondOpinion.sweep.run, {});
    expect(await scheduledRows(f)).toHaveLength(0);
  });
  it("treats an unnamed speaker as the prospect only when no invitee spoke, and sends only the last hour of a long recording", () => {
    const lines = labelSpeakers(
      [
        { atSeconds: 5, speakerName: "Staff", speakerEmail: "staff@example.com", text: "Start" },
        { atSeconds: 7300, speakerName: "Conor", text: "End" },
      ],
      { email: "kim@example.com" },
      [],
    );
    // Fathom gave the prospect no email: the speaker without one is the Prospect.
    expect(lines.map((line) => line.role)).toEqual(["Other", "Prospect"]);
    expect(
      labelSpeakers(
        [
          { atSeconds: 5, speakerName: "Grace", speakerEmail: "grace@example.com", text: "Hi" },
          { atSeconds: 9, speakerName: "Someone", text: "Hello" },
        ],
        { email: "kim@example.com" },
        ["grace@example.com"],
      ).map((line) => line.role),
    ).toEqual(["Prospect", "Other"]);
    expect(
      buildState({ callKind: "new call", recordedMinutes: 130, lines })
        .transcript,
    ).toHaveLength(1);
  });
});

describe("boundary cases", () => {
  it("rejects every 4xx without retrying, including rate-limit responses", async () => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    const fetchStub = vi.fn(async () => response(429));
    vi.stubGlobal("fetch", fetchStub);
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await row(f, id!)).toMatchObject({
      status: "failed",
      failure: "rejected",
      attempts: 1,
    });
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });
  it("rejects invalid reopen dates atomically", async () => {
    const f = await answered();
    await expect(
      f.admin.mutation(api.secondOpinion.check, {
        secondOpinionId: f.id,
        outcome: "second_opinion_right",
        reopen: { date: "2026-02-30", time: "10:00" },
      }),
    ).rejects.toThrow(/real date/);
    expect((await row(f, f.id))?.reviewState).toBe("open");
    expect(
      await f.t.run((ctx) => ctx.db.query("followUps").take(500)),
    ).toHaveLength(0);
  });
  it("skips a transcript that expires between queuing and running", async () => {
    const f = await secondOpinionHarness();
    const id = await f.queue();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptDeletedAt: Date.now(),
        transcriptStorageId: undefined,
      }),
    );
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    await f.t.action(internal.secondOpinion.run.run, {
      secondOpinionId: id!,
      attempt: 0,
    });
    expect(await row(f, id!)).toMatchObject({
      status: "skipped",
      failure: "no_transcript",
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
  it("pages a closed day's meetings without dropping the second page", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    const day = businessDayRange("2026-11-02");
    vi.setSystemTime(day.end + 30 * 60_000);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", f.meetingId, {
        scheduledAt: day.start + 3600_000,
      });
      const {
        _id: _meetingId,
        _creationTime: _meetingTime,
        ...meeting
      } = (await ctx.db.get("meetings", f.meetingId))!;
      const {
        _id: _recordingId,
        _creationTime: _recordingTime,
        ...recording
      } = (await ctx.db.get("callRecordings", f.recordingId))!;
      for (let i = 0; i < 26; i++) {
        const meetingId = await ctx.db.insert("meetings", {
          ...meeting,
          calendlyEventUri: `event-${i}`,
        });
        await ctx.db.insert("callRecordings", {
          ...recording,
          meetingId,
          fathomRecordingId: i + 2,
        });
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    await f.t.mutation(internal.secondOpinion.sweep.run, {});
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const rows = await f.t.run((ctx) =>
      ctx.db.query("secondOpinions").take(500),
    );
    expect(rows).toHaveLength(27);
    expect(rows.every((row) => row.verdict === "hint")).toBe(true);
  });
  it("honors a non-whole-hour business-day boundary", async () => {
    const f = await secondOpinionHarness("on", "scheduled");
    const businessDay = { timeZone: "Asia/Kathmandu", dayStartHour: 1 };
    const day = businessDayRange("2026-11-02", businessDay);
    vi.setSystemTime(day.end + 59 * 60_000);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("tenants", f.tenantId, { businessDay });
      await ctx.db.patch("meetings", f.meetingId, {
        scheduledAt: day.start + 3600_000,
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    await f.t.mutation(internal.secondOpinion.sweep.run, {});
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await f.t.run((ctx) => ctx.db.query("secondOpinions").take(500)),
    ).toHaveLength(1);
  });
});

it("finishes a queued check whose recording was detached before the action ran", async () => {
  const f = await secondOpinionHarness();
  const id = await f.queue();
  await f.t.run((ctx) =>
    ctx.db.patch("callRecordings", f.recordingId, {
      meetingId: undefined,
      matchStatus: "unmatched",
    }),
  );
  const fetchStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
  await f.t.action(internal.secondOpinion.run.run, {
    secondOpinionId: id!,
    attempt: 0,
  });
  expect(await row(f, id!)).toMatchObject({
    status: "skipped",
    failure: "no_transcript",
  });
  expect(fetchStub).not.toHaveBeenCalled();
});
