import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServiceToken } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { onRecordingMatched } from "../fathom/recordings";
import {
  callInsightsHarness,
  decisionsAnswer,
  gatewayFetch,
  messagesResponse,
  PAID_EXTRACTION,
} from "../../tests/callInsightsHarness";
import { monthKeyFor } from "./budget";
import { attachRecordingCore } from "../fathom/recordings";
import { backfillCandidates, startBackfill } from "./jobs";
import { effectiveSettings } from "./settings";
import { liveSuggestionForMeeting } from "./suggest/state";
import { queueRead } from "./trigger";

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

type Harness = Awaited<ReturnType<typeof callInsightsHarness>>;

const runs = (f: Harness) =>
  f.t.run((ctx) => ctx.db.query("callInsightRuns").take(50));
const facts = (f: Harness) =>
  f.t.run((ctx) => ctx.db.query("callInsightFacts").take(200));
const budget = (f: Harness) =>
  f.t.run((ctx) =>
    ctx.db
      .query("callInsightBudgets")
      .withIndex("by_tenantId_and_monthKey", (q) =>
        q.eq("tenantId", f.tenantId).eq("monthKey", monthKeyFor(Date.now())),
      )
      .first(),
  );
const suggestion = (f: Harness) =>
  f.t.run((ctx) =>
    ctx.db
      .query("resultSuggestionStates")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", f.meetingId))
      .first(),
  );
const queue = (f: Harness) =>
  f.t.run((ctx) =>
    queueRead(ctx, {
      recordingId: f.recordingId,
      trigger: "recording_matched",
    }),
  );
const drain = (f: Harness) => f.t.finishAllScheduledFunctions(vi.runAllTimers);
const stubGateway = (opts?: Parameters<typeof gatewayFetch>[0]) => {
  const gateway = gatewayFetch(opts);
  vi.stubGlobal("fetch", vi.fn(gateway.fetchImpl));
  return gateway.calls;
};

/** A second booked meeting for the same prospect, with nothing recorded. */
const secondMeeting = (f: Harness, tag: string) =>
  f.t.run(async (ctx) => {
    const meeting = await ctx.db.get("meetings", f.meetingId);
    if (!meeting) throw new Error("No meeting");
    const { _id, _creationTime, ...rest } = meeting;
    void _id;
    void _creationTime;
    return await ctx.db.insert("meetings", {
      ...rest,
      calendlyEventUri: `event-${tag}`,
      calendlyInviteeUri: `invitee-${tag}`,
    });
  });
/** A second matched recording on its own meeting. */
const secondCall = async (f: Harness, tag: string) => {
  const meetingId = await secondMeeting(f, tag);
  return await f.t.run(async (ctx) => {
    const recording = await ctx.db.get("callRecordings", f.recordingId);
    if (!recording) throw new Error("No recording");
    const { _id, _creationTime, ...rest } = recording;
    void _id;
    void _creationTime;
    return await ctx.db.insert("callRecordings", {
      ...rest,
      fathomRecordingId: 1000 + tag.length,
      meetingId,
    });
  });
};
const header = async (f: Harness) => {
  const row = (await facts(f)).find((fact) => fact.kind === "call");
  if (!row || row.kind !== "call") throw new Error("No header");
  return row;
};
const scheduledReads = async (f: Harness) =>
  (
    await f.t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").take(100),
    )
  ).filter(
    (job) =>
      job.name.includes("run") &&
      job.name.endsWith("read") &&
      job.state.kind === "pending",
  ).length;
const owner = (f: Harness) => ({
  tenantId: f.tenantId,
  userId: f.ownerId,
  role: "tenant_master" as const,
});

describe("the Fathom match hook", () => {
  it("writes and schedules nothing while Call insights is off", async () => {
    const f = await callInsightsHarness({ settings: null });
    const calls = stubGateway();
    await f.t.run((ctx) =>
      onRecordingMatched(ctx, {
        meetingId: f.meetingId,
        recordingId: f.recordingId,
      }),
    );
    await drain(f);
    expect(await runs(f)).toHaveLength(0);
    expect(await facts(f)).toHaveLength(0);
    expect(calls).toEqual({ messages: 0, decisions: 0 });
  });

  it("queues one read however often it fires", async () => {
    const f = await callInsightsHarness();
    stubGateway();
    for (let i = 0; i < 2; i++)
      await f.t.run((ctx) =>
        onRecordingMatched(ctx, {
          meetingId: f.meetingId,
          recordingId: f.recordingId,
        }),
      );
    await drain(f);
    expect(await runs(f)).toHaveLength(1);
  });
});

describe("reading a call", () => {
  it("publishes text-free rows, a suggestion, and settles what it reserved", async () => {
    const f = await callInsightsHarness();
    const calls = stubGateway();
    await queue(f);
    await drain(f);

    const [run] = await runs(f);
    expect(run).toMatchObject({
      status: "answered",
      kind: "full",
      attempt: 1,
      generation: 1,
    });
    expect(run.claimToken).toBeUndefined();
    expect(
      run.items?.map((item) => [item.kind, item.category, item.check]),
    ).toEqual([
      ["objection", "partner", "confirmed"],
      ["income", "personal_income", "confirmed"],
    ]);
    expect(run.primaryBlocker).toBe("partner");
    // One Claude call; Jev: 2 items, 4 readings, 1 result check.
    expect(calls).toEqual({ messages: 1, decisions: 7 });

    const rows = await facts(f);
    const header = rows.find((row) => row.kind === "call");
    expect(header).toMatchObject({
      active: true,
      latestStatus: "answered",
      publicationRevision: 1,
      expectedItemCount: 2,
      primaryBlocker: "partner",
      noShowTier: "none",
    });
    const items = rows.filter((row) => row.kind !== "call");
    expect(items).toHaveLength(2);
    expect(items.find((row) => row.kind === "income")).toMatchObject({
      category: "personal_income",
      currency: "USD",
      currencyAssumed: true,
      minMinor: 600_000,
      maxMinor: 600_000,
      monthlyMinMinor: 600_000,
      band: "b5000",
      check: "confirmed",
      publicationRevision: 1,
    });
    // No prospect words in any published row.
    for (const row of rows) {
      const text = JSON.stringify(row);
      expect(text).not.toContain("husband");
      expect(text).not.toContain("salon");
    }

    expect(await suggestion(f)).toMatchObject({
      kind: "paid",
      tier: "ready",
      revision: 1,
      values: {
        amountMinor: 170_000,
        currency: "USD",
        currencyAssumed: true,
        paymentType: "pif",
      },
    });

    const month = await budget(f);
    expect(month?.reservedMicroUsd).toBe(0);
    expect(month?.spentMicroUsd).toBe(
      run.receipts.reduce(
        (sum, receipt) => sum + (receipt.spentMicroUsd ?? 0),
        0,
      ),
    );
    expect(month?.spentMicroUsd).toBeGreaterThanOrEqual(100_000);
    expect(
      run.receipts.every((receipt) => receipt.settledAt !== undefined),
    ).toBe(true);
  });

  it("never writes a rejected item to the facts and opens a review for it", async () => {
    const f = await callInsightsHarness();
    stubGateway({
      decisions: (body) =>
        decisionsAnswer(body, {
          // Jev disagrees with every item but agrees with the result.
          noul: "result" in body.questions ? 0.95 : 0.1,
        }),
    });
    await queue(f);
    await drain(f);
    const rows = await facts(f);
    expect(rows.filter((row) => row.kind !== "call")).toHaveLength(0);
    const header = rows.find((row) => row.kind === "call");
    expect(header).toMatchObject({ expectedItemCount: 0, rejectedCount: 2 });
    expect(
      header && "primaryBlocker" in header ? header.primaryBlocker : undefined,
    ).toBeUndefined();
    const reviews = await f.t.run((ctx) =>
      ctx.db.query("callInsightItemReviews").take(10),
    );
    expect(reviews.map((review) => review.state)).toEqual(["open", "open"]);
  });

  it("waits without calling a model when the month has no room", async () => {
    // Second opinion's cap takes the whole limit.
    const f = await callInsightsHarness({ settings: { monthlyCapUsd: 40 } });
    const calls = stubGateway();
    await queue(f);
    await drain(f);
    const [run] = await runs(f);
    expect(run).toMatchObject({
      status: "waiting",
      reason: "cap_reached",
      attempt: 0,
    });
    expect(run.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(calls).toEqual({ messages: 0, decisions: 0 });
    expect((await budget(f))?.reservedMicroUsd).toBe(0);
  });

  it("puts a busy gateway's run back in the queue and bills nothing for it", async () => {
    const f = await callInsightsHarness();
    let first = true;
    const calls = stubGateway({
      messages: () => {
        if (first) {
          first = false;
          return new Response("busy", {
            status: 429,
            headers: { "retry-after": "120" },
          });
        }
        return messagesResponse(PAID_EXTRACTION);
      },
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    const [queued] = await runs(f);
    expect(queued).toMatchObject({
      status: "queued",
      reason: "upstream_error",
      attempt: 1,
    });
    // Retry-After (120 s) outlasts the first backoff step.
    expect(queued.nextAttemptAt).toBe(Date.now() + 120_000);
    expect(await budget(f)).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
    });

    await drain(f);
    const [done] = await runs(f);
    expect(done).toMatchObject({ status: "answered", attempt: 2 });
    expect(calls.messages).toBe(2);
  });

  it("fails on output that doesn't match the schema and still books the cost", async () => {
    const f = await callInsightsHarness();
    stubGateway({ messages: () => messagesResponse({ nonsense: true }, 0.05) });
    await queue(f);
    await drain(f);
    const [run] = await runs(f);
    expect(run).toMatchObject({ status: "failed", reason: "format_changed" });
    expect(await budget(f)).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: 50_000,
    });
    expect((await facts(f)).find((row) => row.kind === "call")).toMatchObject({
      latestStatus: "failed",
      reasonCode: "format_changed",
      publicationRevision: 0,
    });
  });

  it("keeps Claude's answer and retries only Jev when Jev is down", async () => {
    const f = await callInsightsHarness();
    let down = true;
    const calls = stubGateway({
      decisions: (body) =>
        down
          ? new Response("unavailable", { status: 503 })
          : decisionsAnswer(body),
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    const [checking] = await runs(f);
    expect(checking).toMatchObject({
      status: "checking",
      reason: "upstream_error",
    });
    expect(checking.items).toHaveLength(2);
    expect(checking.claimToken).toBeUndefined();

    down = false;
    await drain(f);
    const [done] = await runs(f);
    expect(done).toMatchObject({ status: "answered", checkRetries: 1 });
    expect(calls.messages).toBe(1);
  });

  it("skips another prospect's call before anything is paid for", async () => {
    const f = await callInsightsHarness();
    const calls = stubGateway();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        inviteeEmails: ["stranger@elsewhere.com"],
      }),
    );
    await queue(f);
    await drain(f);
    expect((await runs(f))[0]).toMatchObject({
      status: "skipped",
      reason: "other_prospect",
    });
    expect(calls).toEqual({ messages: 0, decisions: 0 });
  });

  it("calls no model for a recording with no lines and suggests listening first", async () => {
    const f = await callInsightsHarness({ transcript: [] });
    const calls = stubGateway();
    await queue(f);
    await drain(f);
    expect((await runs(f))[0]).toMatchObject({
      status: "skipped",
      reason: "no_prospect_speech",
    });
    expect(calls).toEqual({ messages: 0, decisions: 0 });
    expect((await facts(f)).find((row) => row.kind === "call")).toMatchObject({
      latestStatus: "skipped",
      noShowTier: "empty",
    });
    expect(await suggestion(f)).toMatchObject({
      kind: "empty_recording",
      tier: "unconfirmed",
    });
  });
});

describe("fences", () => {
  async function checkingRun() {
    const f = await callInsightsHarness();
    // Jev down leaves the run in its Jev stage with Claude's answer saved.
    stubGateway({
      decisions: () => new Response("unavailable", { status: 503 }),
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    // The Jev retry waits a minute.
    vi.setSystemTime(Date.now() + 61_000);
    const claim = await f.t.mutation(internal.callInsights.run.begin, {
      runId,
      kind: "full",
      expect: "check",
      claudeMicroUsd: 0,
      jevMicroUsd: 1_000,
      secondOpinionSpentUsd: 0,
    });
    if (!claim) throw new Error("Run was not claimed");
    const run = (await runs(f))[0];
    return { f, runId, claimToken: claim.claimToken, items: run.items ?? [] };
  }
  const reading = { incomplete: true };

  it("a worker holding an old token publishes nothing", async () => {
    const { f, runId, items } = await checkingRun();
    await f.t.mutation(internal.callInsights.run.publish, {
      runId,
      claimToken: "stale",
      items,
      earlyReading: reading,
      jevCost: { costUsd: 0 },
    });
    expect((await runs(f))[0].status).toBe("checking");
    expect((await facts(f)).filter((row) => row.kind !== "call")).toHaveLength(
      0,
    );
  });

  it("a recording moved to another meeting mid-read is not published", async () => {
    const { f, runId, claimToken, items } = await checkingRun();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        matchStatus: "unmatched",
        meetingId: undefined,
      }),
    );
    await f.t.mutation(internal.callInsights.run.publish, {
      runId,
      claimToken,
      items,
      earlyReading: reading,
      jevCost: { costUsd: 0 },
    });
    expect((await runs(f))[0]).toMatchObject({
      status: "skipped",
      reason: "recording_moved",
    });
    expect((await facts(f)).filter((row) => row.kind !== "call")).toHaveLength(
      0,
    );
    expect((await budget(f))?.reservedMicroUsd).toBe(0);
  });

  it("only one of two claims takes the last of the month's room", async () => {
    // Limit: 40.00008 cap - 40 Second opinion share = 80 micro-USD... so set it by hand.
    const f = await callInsightsHarness({ settings: { monthlyCapUsd: 40.1 } });
    const second = await f.t.run(async (ctx) => {
      const recording = await ctx.db.get("callRecordings", f.recordingId);
      if (!recording) throw new Error("No recording");
      const { _id, _creationTime, ...rest } = recording;
      void _id;
      void _creationTime;
      const meeting = await ctx.db.get("meetings", f.meetingId);
      if (!meeting) throw new Error("No meeting");
      const { _id: m, _creationTime: c, ...meetingRest } = meeting;
      void m;
      void c;
      const meetingId = await ctx.db.insert("meetings", {
        ...meetingRest,
        calendlyEventUri: "event-2",
        calendlyInviteeUri: "invitee-2",
      });
      return await ctx.db.insert("callRecordings", {
        ...rest,
        fathomRecordingId: 2,
        meetingId,
      });
    });
    const first = (await queue(f)) as Id<"callInsightRuns">;
    const other = (await f.t.run((ctx) =>
      queueRead(ctx, { recordingId: second, trigger: "recording_matched" }),
    )) as Id<"callInsightRuns">;
    // $0.10 of room: each claim wants $0.07.
    const claim = (runId: Id<"callInsightRuns">) =>
      f.t.mutation(internal.callInsights.run.begin, {
        runId,
        kind: "full",
        expect: "extract",
        claudeMicroUsd: 60_000,
        jevMicroUsd: 10_000,
        secondOpinionSpentUsd: 0,
      });
    expect(await claim(first)).not.toBeNull();
    expect(await claim(other)).toBeNull();
    const all = await runs(f);
    expect(all.map((run) => run.status).sort()).toEqual(["running", "waiting"]);
    expect((await budget(f))?.reservedMicroUsd).toBe(70_000);
  });
});

describe("upkeep", () => {
  it("hands a dead worker's run to a new one and keeps its reservation as spent", async () => {
    const f = await callInsightsHarness();
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.mutation(internal.callInsights.run.begin, {
      runId,
      kind: "full",
      expect: "extract",
      claudeMicroUsd: 60_000,
      jevMicroUsd: 10_000,
      secondOpinionSpentUsd: 0,
    });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await f.t.mutation(internal.callInsights.maintenance.sweep, {});
    const [run] = await runs(f);
    expect(run).toMatchObject({
      status: "queued",
      reason: "lease_expired",
      attempt: 1,
    });
    expect(run.claimToken).toBeUndefined();
    expect(await budget(f)).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: 70_000,
    });
  });

  it("sends a recovered Opus judge run back to the judge, never into an extraction", async () => {
    const f = await callInsightsHarness();
    const runId = await f.t.run(async (ctx) => {
      const caseId = await ctx.db.insert("callInsightEvalCases", {
        tenantId: f.tenantId,
        recordingId: f.recordingId,
        meetingId: f.meetingId,
        campaign: "test",
        split: "calib",
        groupKey: "lead",
        status: "labels_committed",
        labelRevision: 1,
        purgeAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("callInsightRuns", {
        tenantId: f.tenantId,
        recordingId: f.recordingId,
        meetingId: f.meetingId,
        purpose: "eval",
        evalRole: "judge",
        evalCaseId: caseId,
        generation: 0,
        inputKey: `${f.recordingId}:eval:judge:${caseId}:a`,
        trigger: "eval",
        kind: "full",
        status: "running",
        attempt: 1,
        claimToken: "dead-worker",
        leaseUntil: Date.now() - 60_000,
        config: {
          model: "anthropic/claude-opus-5.5",
          promptVersion: "p1",
          taxonomyVersion: "v1",
          thresholdsVersion: "t1",
          itemCheck: true,
        },
        receipts: [],
        createdAt: Date.now(),
      });
    });
    // The extraction loader refuses a judge run outright.
    expect(
      await f.t.query(internal.callInsights.run.load, { runId }),
    ).toBeNull();
    await f.t.mutation(internal.callInsights.maintenance.sweep, {});
    const scheduled = await f.t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").take(50),
    );
    const names = scheduled.map((job) => job.name);
    expect(
      names.some(
        (name) => name.includes("judge") && name.includes("judgeCase"),
      ),
    ).toBe(true);
    expect(
      names.some((name) => name.includes("run") && name.endsWith("read")),
    ).toBe(false);
  });

  it("deletes every prospect word when the transcript goes, and keeps the categories", async () => {
    const f = await callInsightsHarness();
    stubGateway();
    await queue(f);
    await drain(f);
    await f.t.mutation(internal.callInsights.maintenance.purgeRecording, {
      recordingId: f.recordingId,
    });
    await drain(f);
    const [run] = await runs(f);
    expect(run.quotesPurgedAt).toBeDefined();
    expect(
      run.items?.map((item) => [item.category, item.statement, item.quote]),
    ).toEqual([
      ["partner", "", ""],
      ["personal_income", "", ""],
    ]);
    expect(run.result?.quotes.every((quote) => quote.quote === "")).toBe(true);
    const row = await suggestion(f);
    expect(row?.quotes.every((quote) => quote.quote === "")).toBe(true);
    expect(
      (await facts(f)).filter((fact) => fact.kind !== "call"),
    ).toHaveLength(2);
    // Nothing the prospect or the model said is left anywhere, labels included.
    const stored = JSON.stringify([run, row, await facts(f)]);
    for (const word of [
      "husband",
      "salon",
      "1,700",
      "my card",
      "Earns",
      "Needs to talk",
    ])
      expect(stored).not.toContain(word);
    expect(row?.quotes.map((quote) => quote.label)).toEqual([
      "Price",
      "Agreement",
    ]);
  });

  it("purges every run of a recording, however many there are", async () => {
    const f = await callInsightsHarness();
    stubGateway();
    await queue(f);
    await drain(f);
    const [published] = await runs(f);
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = published;
      void _id;
      void _creationTime;
      // More readings than one cleanup pass handles: eval reads of the same call.
      for (let n = 0; n < 30; n++)
        await ctx.db.insert("callInsightRuns", {
          ...rest,
          purpose: "eval",
          evalRole: "candidate",
          generation: 0,
          inputKey: `${f.recordingId}:eval:candidate:${n}`,
        });
    });
    await f.t.mutation(internal.callInsights.maintenance.purgeRecording, {
      recordingId: f.recordingId,
    });
    await drain(f);
    const all = await f.t.run((ctx) =>
      ctx.db.query("callInsightRuns").take(100),
    );
    expect(all).toHaveLength(31);
    expect(all.every((run) => run.quotesPurgedAt !== undefined)).toBe(true);
    expect(JSON.stringify(all)).not.toContain("husband");
  });

  it("a reading still in flight when the transcript goes can't write its words afterwards", async () => {
    const f = await callInsightsHarness();
    // Jev down leaves the run in its Jev stage, holding Claude's answer.
    stubGateway({
      decisions: () => new Response("unavailable", { status: 503 }),
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    vi.setSystemTime(Date.now() + 61_000);
    const claim = await f.t.mutation(internal.callInsights.run.begin, {
      runId,
      kind: "full",
      expect: "check",
      claudeMicroUsd: 0,
      jevMicroUsd: 1_000,
      secondOpinionSpentUsd: 0,
    });
    const before = (await runs(f))[0];
    await f.t.mutation(internal.callInsights.maintenance.purgeRecording, {
      recordingId: f.recordingId,
    });
    // The worker comes back late with everything it read.
    await f.t.mutation(internal.callInsights.run.publish, {
      runId,
      claimToken: claim!.claimToken,
      items: before.items ?? [],
      earlyReading: { incomplete: true },
      jevCost: { costUsd: 0 },
    });
    await f.t.mutation(internal.callInsights.run.release, {
      runId,
      claimToken: claim!.claimToken,
      reason: "upstream_error",
      retry: true,
      costs: {},
      items: before.items,
    });
    const [after] = await runs(f);
    expect(after).toMatchObject({ status: "skipped", reason: "no_transcript" });
    expect(after.claimToken).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("husband");
    expect(
      (await facts(f)).filter((fact) => fact.kind !== "call"),
    ).toHaveLength(0);
    expect((await budget(f))?.reservedMicroUsd).toBe(0);
  });

  it("stops offering a suggestion the moment the transcript expires, before any cleanup", async () => {
    const f = await callInsightsHarness({ settings: { suggestions: "on" } });
    stubGateway();
    await queue(f);
    await drain(f);
    const live = () =>
      f.t.run(async (ctx) => {
        const tenant = await ctx.db.get("tenants", f.tenantId);
        const meeting = await ctx.db.get("meetings", f.meetingId);
        if (!tenant || !meeting) throw new Error("Missing fixture");
        return await liveSuggestionForMeeting(ctx, {
          tenant,
          meeting,
          now: Date.now(),
        });
      });
    expect(await live()).not.toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptExpiresAt: Date.now() - 1,
      }),
    );
    expect(await live()).toBeNull();
  });

  it("shows a saved reading on the meeting a recording is re-matched to, without a new call", async () => {
    const f = await callInsightsHarness();
    const calls = stubGateway();
    await queue(f);
    await drain(f);
    const newMeetingId = await f.t.run(async (ctx) => {
      const meeting = await ctx.db.get("meetings", f.meetingId);
      if (!meeting) throw new Error("No meeting");
      const { _id, _creationTime, ...rest } = meeting;
      void _id;
      void _creationTime;
      const id = await ctx.db.insert("meetings", {
        ...rest,
        calendlyEventUri: "event-3",
        calendlyInviteeUri: "invitee-3",
      });
      await ctx.db.patch("callRecordings", f.recordingId, { meetingId: id });
      return id;
    });
    await queue(f);
    await drain(f);
    expect(calls.messages).toBe(1);
    expect(await runs(f)).toHaveLength(1);
    const rows = await facts(f);
    expect(rows.every((row) => row.meetingId === newMeetingId)).toBe(true);
    expect(rows.find((row) => row.kind === "call")).toMatchObject({
      publicationRevision: 2,
    });
  });
});

describe("backfill jobs", () => {
  it("reads the calls it froze, counts them and finishes", async () => {
    const f = await callInsightsHarness();
    stubGateway();
    const jobId = await f.t.run(async (ctx) => {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      if (!tenant) throw new Error("No tenant");
      return await startBackfill(ctx, {
        tenant,
        userId: f.ownerId,
        scope: "unread",
        ceilingUsd: 5,
      });
    });
    expect(jobId).not.toBeNull();
    await drain(f);
    const job = await f.t.run((ctx) => ctx.db.get("callInsightJobs", jobId!));
    expect(job).toMatchObject({ status: "done", total: 1, done: 1, failed: 0 });
    expect(job?.spentMicroUsd).toBeGreaterThan(0);
    expect((await runs(f))[0]).toMatchObject({
      status: "answered",
      trigger: "backfill",
    });
  });

  it("stops before a call that could pass its ceiling", async () => {
    const f = await callInsightsHarness();
    const calls = stubGateway();
    const jobId = await f.t.run(async (ctx) => {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      if (!tenant) throw new Error("No tenant");
      return await startBackfill(ctx, {
        tenant,
        userId: f.ownerId,
        scope: "unread",
        ceilingUsd: 0.1,
      });
    });
    await drain(f);
    const job = await f.t.run((ctx) => ctx.db.get("callInsightJobs", jobId!));
    expect(job).toMatchObject({ status: "done", done: 0, skipped: 1 });
    expect(calls.messages).toBe(0);
  });
});

describe("claims", () => {
  it("a worker that loaded the run before Claude answered can't claim its Jev stage", async () => {
    const f = await callInsightsHarness();
    const calls = stubGateway({
      decisions: () => new Response("unavailable", { status: 503 }),
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    vi.setSystemTime(Date.now() + 61_000);
    // It still thinks the run is queued and would call Claude with nothing reserved.
    const stale = await f.t.mutation(internal.callInsights.run.begin, {
      runId,
      kind: "full",
      expect: "extract",
      claudeMicroUsd: 60_000,
      jevMicroUsd: 10_000,
      secondOpinionSpentUsd: 0,
    });
    expect(stale).toBeNull();
    const [run] = await runs(f);
    expect(run.status).toBe("checking");
    expect(run.checkRetries ?? 0).toBe(0);
    expect(run.claimToken).toBeUndefined();
    expect((await budget(f))?.reservedMicroUsd).toBe(0);
    expect(calls.messages).toBe(1);
  });

  it("a retry scheduled early waits out its backoff", async () => {
    const f = await callInsightsHarness();
    stubGateway({
      decisions: () => new Response("unavailable", { status: 503 }),
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    const claim = () =>
      f.t.mutation(internal.callInsights.run.begin, {
        runId,
        kind: "full",
        expect: "check",
        claudeMicroUsd: 0,
        jevMicroUsd: 1_000,
        secondOpinionSpentUsd: 0,
      });
    expect(await claim()).toBeNull();
    vi.setSystemTime(Date.now() + 61_000);
    expect(await claim()).not.toBeNull();
  });

  it("a job's calls never reserve past its ceiling, even two at once", async () => {
    const f = await callInsightsHarness();
    const other = await secondCall(f, "b");
    const { jobId, first, second } = await f.t.run(async (ctx) => {
      const jobId = await ctx.db.insert("callInsightJobs", {
        tenantId: f.tenantId,
        kind: "backfill",
        status: "running",
        // Room for one call's reservation (70,000), not two.
        ceilingMicroUsd: 100_000,
        spentMicroUsd: 0,
        estimateMicroUsd: 0,
        total: 2,
        done: 0,
        failed: 0,
        skipped: 0,
        createdByUserId: f.ownerId,
        createdAt: Date.now(),
      });
      const ids: Id<"callInsightRuns">[] = [];
      for (const recordingId of [f.recordingId, other]) {
        const runId = await queueRead(ctx, {
          recordingId,
          trigger: "backfill",
          jobId,
        });
        if (!runId) throw new Error("Not queued");
        await ctx.db.insert("callInsightJobItems", {
          tenantId: f.tenantId,
          jobId,
          recordingId,
          order: 0,
          status: "running",
          runId,
        });
        ids.push(runId);
      }
      return { jobId, first: ids[0], second: ids[1] };
    });
    const claim = (runId: Id<"callInsightRuns">) =>
      f.t.mutation(internal.callInsights.run.begin, {
        runId,
        kind: "full",
        expect: "extract",
        claudeMicroUsd: 60_000,
        jevMicroUsd: 10_000,
        secondOpinionSpentUsd: 0,
      });
    expect(await claim(first)).not.toBeNull();
    expect(await claim(second)).toBeNull();
    const all = await runs(f);
    expect(all.find((run) => run._id === second)).toMatchObject({
      status: "skipped",
      reason: "canceled",
    });
    expect((await budget(f))?.reservedMicroUsd).toBe(70_000);
    expect(jobId).toBeDefined();
  });

  it("ends a run that became unreadable between Jev retries", async () => {
    const f = await callInsightsHarness();
    stubGateway({
      decisions: () => new Response("unavailable", { status: 503 }),
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        inviteeEmails: ["stranger@elsewhere.com"],
      }),
    );
    await drain(f);
    expect((await runs(f))[0]).toMatchObject({
      status: "skipped",
      reason: "other_prospect",
    });
    expect(await header(f)).toMatchObject({
      latestStatus: "skipped",
      publicationRevision: 0,
    });
  });
});

describe("what the model is told", () => {
  it("gives the day of the call where the tenant is, not the UTC date", async () => {
    const f = await callInsightsHarness();
    // 7 pm on November 12 in Tegucigalpa is already November 13 in UTC.
    const start = Date.parse("2026-11-13T01:00:00Z");
    await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", f.meetingId, { scheduledAt: start });
      await ctx.db.patch("callRecordings", f.recordingId, {
        recordingStartAt: start,
        recordingEndAt: start + 25 * 60_000,
        transcriptExpiresAt: start + 90 * 86_400_000,
      });
    });
    vi.setSystemTime(start + 2 * 3_600_000);
    const gateway = gatewayFetch();
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/messages"))
          prompts.push(JSON.stringify(JSON.parse(String(init?.body))));
        return gateway.fetchImpl(input, init);
      }),
    );
    await queue(f);
    await drain(f);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Today: 2026-11-12");
    expect(prompts[0]).toContain("Tenant time zone: America/Tegucigalpa");
  });
});

describe("costs nobody reported", () => {
  it("keeps the whole Jev reservation when an answer comes back without its cost", async () => {
    const f = await callInsightsHarness();
    stubGateway({
      decisions: (body) => decisionsAnswer(body, { noCost: true }),
    });
    await queue(f);
    await drain(f);
    const [run] = await runs(f);
    expect(run.status).toBe("answered");
    const jev = run.receipts.find((receipt) => receipt.key.startsWith("jev:"));
    expect(jev?.reservedMicroUsd).toBeGreaterThan(0);
    expect(jev?.spentMicroUsd).toBe(jev?.reservedMicroUsd);
  });

  it("keeps Claude's reservation when the request never got an answer", async () => {
    const f = await callInsightsHarness();
    stubGateway({
      messages: () => {
        throw new Error("socket closed");
      },
    });
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    await f.t.action(internal.callInsights.run.read, { runId });
    const [run] = await runs(f);
    expect(run).toMatchObject({ status: "queued", reason: "upstream_error" });
    const claude = run.receipts.find((receipt) => receipt.key === "claude:1");
    expect(claude?.spentMicroUsd).toBe(claude?.reservedMicroUsd);
    // Jev was never called, so its reservation went back.
    expect(
      run.receipts.find((receipt) => receipt.key === "jev:1")?.spentMicroUsd,
    ).toBe(0);
  });
});

describe("the sweep", () => {
  it("starts a queued run whose scheduled read never fired, without pushing it back", async () => {
    const f = await callInsightsHarness();
    await queue(f);
    const [queued] = await runs(f);
    expect(queued.nextAttemptAt).toBe(Date.now());
    expect(await scheduledReads(f)).toBe(1);
    // Not late enough to be called lost.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await f.t.mutation(internal.callInsights.maintenance.sweep, {});
    expect(await scheduledReads(f)).toBe(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await f.t.mutation(internal.callInsights.maintenance.sweep, {});
    expect(await scheduledReads(f)).toBe(2);
    expect((await runs(f))[0].nextAttemptAt).toBe(queued.nextAttemptAt);
  });

  it("reads a waiting call once the month has room again", async () => {
    const f = await callInsightsHarness({ settings: { monthlyCapUsd: 40 } });
    const calls = stubGateway();
    await queue(f);
    await drain(f);
    expect((await runs(f))[0]).toMatchObject({
      status: "waiting",
      reason: "cap_reached",
    });
    await f.t.run(async (ctx) => {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      if (!tenant?.callInsights) throw new Error("No settings");
      await ctx.db.patch("tenants", f.tenantId, {
        callInsights: { ...tenant.callInsights, monthlyCapUsd: 60 },
      });
    });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await f.t.mutation(internal.callInsights.maintenance.sweep, {});
    await drain(f);
    expect((await runs(f))[0]).toMatchObject({ status: "answered" });
    expect(calls.messages).toBe(1);
  });
});

describe("a recording that changes meeting", () => {
  it("drops the old meeting's timing and no-show reading when its items move", async () => {
    const f = await callInsightsHarness();
    stubGateway();
    await queue(f);
    await drain(f);
    expect((await runs(f))[0].measures).toBeDefined();
    expect((await header(f)).endOffsetSeconds).toBeDefined();
    const newMeetingId = await secondMeeting(f, "moved");
    await f.t.run((ctx) =>
      attachRecordingCore(ctx, owner(f), {
        recordingId: f.recordingId,
        meetingId: newMeetingId,
      }),
    );
    await drain(f);
    const [run] = await runs(f);
    expect(run.meetingId).toBe(newMeetingId);
    expect(run.measures).toBeUndefined();
    const call = await header(f);
    expect(call).toMatchObject({
      meetingId: newMeetingId,
      active: true,
      noShowTier: "none",
    });
    expect(call.endOffsetSeconds).toBeUndefined();
    expect(call.shadowTiers).toBeUndefined();
    const rows = (await facts(f)).filter((row) => row.kind !== "call");
    expect(rows.length).toBe(call.expectedItemCount);
    expect(rows.every((row) => row.meetingId === newMeetingId)).toBe(true);
  });

  it("reads an attendance-only call again for its new meeting", async () => {
    const f = await callInsightsHarness({
      transcript: [
        {
          speaker: "Kim",
          email: "kim@example.com",
          timestamp: "00:00:05",
          text: "Hello, are you there?",
        },
        {
          speaker: "Kim",
          email: "kim@example.com",
          timestamp: "00:08:00",
          text: "I'll give it a few more minutes.",
        },
        {
          speaker: "Kim",
          email: "kim@example.com",
          timestamp: "00:12:00",
          text: "Nobody came, I'm going to hop off.",
        },
      ],
    });
    const calls = stubGateway({
      extraction: { reading: "absent", quotes: [], reachOutcome: "none" },
      decisions: (body) =>
        decisionsAnswer(body, { attendance: ["no_show", 0.95] }),
    });
    await queue(f);
    await drain(f);
    expect((await runs(f))[0]).toMatchObject({
      status: "answered",
      kind: "attendance_only",
    });
    const newMeetingId = await secondMeeting(f, "moved");
    await f.t.run((ctx) =>
      attachRecordingCore(ctx, owner(f), {
        recordingId: f.recordingId,
        meetingId: newMeetingId,
      }),
    );
    await drain(f);
    const all = await runs(f);
    expect(all).toHaveLength(2);
    expect(all.find((run) => run.generation === 2)).toMatchObject({
      status: "answered",
      meetingId: newMeetingId,
    });
    // The first reading keeps the meeting it measured.
    expect(all.find((run) => run.generation === 1)?.meetingId).toBe(
      f.meetingId,
    );
    expect(calls.messages).toBe(2);
    expect(await header(f)).toMatchObject({
      meetingId: newMeetingId,
      publishedGeneration: 2,
    });
  });

  it("queues the new meeting's read when the recording moved mid-read", async () => {
    const f = await callInsightsHarness();
    const calls = stubGateway();
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    const newMeetingId = await secondMeeting(f, "moved");
    // Moved before the first read started: that read ends as "recording moved".
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        meetingId: newMeetingId,
      }),
    );
    await f.t.action(internal.callInsights.run.read, { runId });
    expect((await runs(f))[0]).toMatchObject({
      status: "skipped",
      reason: "recording_moved",
    });
    await drain(f);
    const all = await runs(f);
    expect(all).toHaveLength(2);
    expect(all.find((run) => run.generation === 2)).toMatchObject({
      status: "answered",
      meetingId: newMeetingId,
    });
    expect(calls.messages).toBe(1);
  });

  it("stops counting a call marked not a sales call, and counts it again when re-matched", async () => {
    const f = await callInsightsHarness({ settings: { suggestions: "on" } });
    const calls = stubGateway();
    await queue(f);
    await drain(f);
    const before = await header(f);
    expect(before.expectedItemCount).toBeGreaterThan(0);
    expect(await suggestion(f)).not.toBeNull();

    await f.t.run((ctx) =>
      attachRecordingCore(ctx, owner(f), {
        recordingId: f.recordingId,
        notASalesCall: true,
      }),
    );
    expect(await header(f)).toMatchObject({
      active: false,
      expectedItemCount: 0,
    });
    expect((await facts(f)).filter((row) => row.kind !== "call")).toHaveLength(
      0,
    );
    expect(await suggestion(f)).toBeNull();

    await f.t.run((ctx) =>
      attachRecordingCore(ctx, owner(f), {
        recordingId: f.recordingId,
        meetingId: f.meetingId,
      }),
    );
    await drain(f);
    expect(await header(f)).toMatchObject({
      active: true,
      expectedItemCount: before.expectedItemCount,
      noShowTier: before.noShowTier,
    });
    expect((await facts(f)).filter((row) => row.kind !== "call")).toHaveLength(
      before.expectedItemCount,
    );
    expect(await suggestion(f)).toMatchObject({ kind: "paid" });
    expect(await runs(f)).toHaveLength(1);
    expect(calls.messages).toBe(1);
  });
});

describe("what a no-show reading may rely on", () => {
  it("doesn't vouch for the window when the scan for other recordings hit its cap", async () => {
    const f = await callInsightsHarness();
    const runId = (await queue(f)) as Id<"callInsightRuns">;
    const loaded = () => f.t.query(internal.callInsights.run.load, { runId });
    expect((await loaded())?.input?.traceCoversWindow).toBe(true);
    await f.t.run(async (ctx) => {
      const recording = await ctx.db.get("callRecordings", f.recordingId);
      if (!recording) throw new Error("No recording");
      const { _id, _creationTime, ...rest } = recording;
      void _id;
      void _creationTime;
      for (let i = 0; i < 200; i++)
        await ctx.db.insert("callRecordings", {
          ...rest,
          fathomRecordingId: 5000 + i,
          meetingId: undefined,
          matchStatus: "ignored",
          recordedByEmail: "someone-else@example.com",
        });
    });
    expect((await loaded())?.input?.traceCoversWindow).toBe(false);
  });
});

describe("what a backfill picks", () => {
  const candidates = (f: Harness, scope: "unread" | "unread_and_outdated") =>
    f.t.run(async (ctx) => {
      const settings = effectiveSettings(
        await ctx.db.get("tenants", f.tenantId),
      );
      if (!settings) throw new Error("No settings");
      return await backfillCandidates(
        ctx,
        f.tenantId,
        settings,
        scope,
        Date.now(),
      );
    });

  it("an unread call, then nothing once it was read, then the call again when the prompt changed", async () => {
    const f = await callInsightsHarness();
    stubGateway();
    expect((await candidates(f, "unread")).candidates).toHaveLength(1);
    await queue(f);
    await drain(f);
    expect((await candidates(f, "unread")).candidates).toHaveLength(0);
    expect(
      (await candidates(f, "unread_and_outdated")).candidates,
    ).toHaveLength(0);
    const call = await header(f);
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", call._id, { promptVersion: "p0" }),
    );
    expect((await candidates(f, "unread_and_outdated")).candidates).toEqual([
      expect.objectContaining({ recordingId: f.recordingId, outdated: true }),
    ]);
    expect((await candidates(f, "unread")).candidates).toHaveLength(0);
  });

  it("offers a failed read again and leaves an expired transcript out", async () => {
    const f = await callInsightsHarness();
    stubGateway({ messages: () => messagesResponse({ nonsense: true }, 0.05) });
    await queue(f);
    await drain(f);
    expect((await candidates(f, "unread")).candidates).toHaveLength(1);
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptExpiresAt: Date.now() - 1,
      }),
    );
    expect(await candidates(f, "unread")).toMatchObject({
      candidates: [],
      expired: 1,
    });
  });
});
