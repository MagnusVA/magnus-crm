import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServiceToken } from "convex/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { secondOpinionHarness, decisionsResponse } from "../../tests/secondOpinionHarness";
import { combineReadings, THIN_TRANSCRIPT_WORDS } from "./run";

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

type Harness = Awaited<ReturnType<typeof secondOpinionHarness>>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const row = (f: Harness, id: Id<"secondOpinions">) => f.t.run((ctx) => ctx.db.get("secondOpinions", id));
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

/** A held call whose result is a call-back, and a transcript of the given prospect length. */
async function heldCallBack(prospectWords: number) {
  const f = await secondOpinionHarness("on", "held");
  await f.patchDeal({ stage: "follow_up" });
  await f.t.run(async (ctx) => {
    await ctx.db.insert("followUps", {
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
    });
    const transcriptStorageId = await ctx.storage.store(
      new Blob(
        [
          JSON.stringify([
            { speaker: "Kim", email: "kim@example.com", timestamp: "00:00:05", text: "Hello." },
            // No email from Fathom: the speaker is still the prospect.
            { speaker: "Grace", timestamp: "00:00:20", text: words(prospectWords) },
            { speaker: "Kim", email: "kim@example.com", timestamp: "00:20:00", text: "Talk Friday." },
          ]),
        ],
        { type: "application/json" },
      ),
    );
    await ctx.db.patch("callRecordings", f.recordingId, { transcriptStorageId });
  });
  return f;
}

async function run(f: Harness, id: Id<"secondOpinions">) {
  await f.t.action(internal.secondOpinion.run.run, { secondOpinionId: id, attempt: 0 });
}

describe("thin transcripts", () => {
  it("skips a call-back with almost no prospect speech, without calling the gateway", async () => {
    const f = await heldCallBack(THIN_TRANSCRIPT_WORDS - 1);
    const fetchStub = vi.fn(async () => json(decisionsResponse()));
    vi.stubGlobal("fetch", fetchStub);
    const id = await f.queue();
    await run(f, id!);
    expect(await row(f, id!)).toMatchObject({ status: "skipped", failure: "thin_transcript" });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(getServiceToken).not.toHaveBeenCalled();
  });
  it("checks the same call once the prospect says enough, labelling them Prospect", async () => {
    const f = await heldCallBack(THIN_TRANSCRIPT_WORDS);
    const fetchStub = vi.fn<typeof fetch>(async () => json(decisionsResponse()));
    vi.stubGlobal("fetch", fetchStub);
    const id = await f.queue();
    await run(f, id!);
    expect(await row(f, id!)).toMatchObject({ status: "answered", calls: 6 });
    const request = JSON.parse(String(fetchStub.mock.calls[0][1]?.body));
    expect(request.state.transcript.map((l: { speaker: string }) => l.speaker)).toEqual([
      "Closer",
      "Prospect",
      "Closer",
    ]);
  });
});

describe("another prospect's recording", () => {
  it("skips a recording whose only outside invitee isn't this prospect", async () => {
    const f = await secondOpinionHarness();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        inviteeEmails: ["kim@example.com", "rekha@elsewhere.com"],
      }),
    );
    const id = await f.queue();
    expect(await row(f, id!)).toMatchObject({ status: "skipped", failure: "other_prospect" });
    expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(10))).toHaveLength(0);
  });
  it.each([
    ["the prospect is invited", ["rekha@elsewhere.com", "GRACE@example.com"]],
    ["only the team is invited", ["kim@example.com", "admin@example.com"]],
    ["nobody is invited", []],
  ])("queues as usual when %s", async (_label, inviteeEmails) => {
    const f = await secondOpinionHarness();
    await f.t.run((ctx) => ctx.db.patch("callRecordings", f.recordingId, { inviteeEmails }));
    const id = await f.queue();
    expect(await row(f, id!)).toMatchObject({ status: "queued" });
  });
});

describe("two readings", () => {
  it("averages the readings and is not sure when they split on the ending", async () => {
    const f = await heldCallBack(200);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const withSummary = body.state.fathomSummary !== undefined;
        return json({
          id: withSummary ? "with-summary" : "transcript-only",
          answers: {
            attendance: { choice: "held", confidence: 0.99 },
            ending: withSummary
              ? { choice: "call_back", probabilities: { call_back: 0.9, lost: 0.1 } }
              : { choice: "lost", probabilities: { call_back: 0.3, lost: 0.7 } },
            objection: { choice: "timing", confidence: 0.8 },
            claim: { noul: withSummary ? 0.9 : 0.7 },
          },
          usage: { input_tokens: 100, output_tokens: 2, cost: 0.001 },
        });
      }),
    );
    const id = await f.queue();
    await run(f, id!);
    const checked = await row(f, id!);
    expect(checked).toMatchObject({ status: "answered", verdict: "unsure", split: ["ending"], calls: 6 });
    expect(checked?.answers?.ending.choice).toBe("call_back");
    expect(checked?.answers?.ending.confidence).toBeCloseTo(0.6);
    expect(checked?.answers?.claim).toBeCloseTo(0.8);
  });
  it("sums usage and keeps only asked questions from each reading", () => {
    const combined = combineReadings([
      { parsed: { id: "a", answers: { attendance: { choice: "held", confidence: 0.9 } }, inputTokens: 10, outputTokens: 1, costUsd: 0.5 } },
      { parsed: { id: "b", answers: { ending: { choice: "paid", confidence: 0.8 }, objection: { choice: "none", confidence: 0.7 } }, inputTokens: 5, outputTokens: undefined, costUsd: 0.25 } },
      { parsed: { id: "c", answers: { claim: 0.4 }, inputTokens: undefined, outputTokens: 2, costUsd: undefined } },
    ]);
    expect(combined).toMatchObject({
      answers: { attendance: { choice: "held" }, ending: { choice: "paid" }, objection: { choice: "none" }, claim: 0.4 },
      split: [],
      gatewayRequestId: "a",
      inputTokens: 15,
      outputTokens: 3,
      costUsd: 0.75,
    });
  });
});

describe("rerun", () => {
  async function answeredCheck(mode: "shadow" | "on" = "shadow") {
    const f = await secondOpinionHarness(mode);
    vi.stubGlobal("fetch", vi.fn(async () => json(decisionsResponse())));
    const id = await f.queue();
    await run(f, id!);
    return { ...f, id: id! };
  }
  it("lets an admin run Jev again during the shadow run, replacing the open check", async () => {
    const f = await answeredCheck();
    expect(await row(f, f.id)).toMatchObject({ verdict: "disagrees", reviewState: "open" });
    const detail = await f.admin.query(api.secondOpinion.getForReview, { secondOpinionId: f.id });
    expect(detail?.canRerun).toBe(true);

    const newId = await f.admin.mutation(api.secondOpinion.rerun, { secondOpinionId: f.id });
    expect(await row(f, newId)).toMatchObject({
      status: "queued",
      trigger: "rerun",
      rerunOf: f.id,
      requestedByUserId: f.adminId,
      record: { kind: "no_show" },
    });
    const replaced = await row(f, f.id);
    expect(replaced).toMatchObject({ supersededById: newId });
    expect(replaced?.reviewState).toBeUndefined();
    // The replacement shows while it runs; the replaced check leaves the queue.
    const running = await f.admin.query(api.secondOpinion.getForReview, { secondOpinionId: newId });
    expect(running?.opinion.status).toBe("queued");
    expect((await f.admin.query(api.secondOpinion.getForReview, { secondOpinionId: f.id }))?.canRerun).toBe(false);
    await expect(f.admin.mutation(api.secondOpinion.rerun, { secondOpinionId: newId })).rejects.toThrow(
      /still checking/,
    );
    await expect(f.admin.mutation(api.secondOpinion.rerun, { secondOpinionId: f.id })).rejects.toThrow(
      /newer check/,
    );

    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await row(f, newId)).toMatchObject({ status: "answered", verdict: "disagrees", reviewState: "open" });
    const queue = await f.admin.query(api.secondOpinion.listForReview, {
      tab: "all",
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(queue.page.map((d) => d.opinion._id)).toEqual([newId]);
    // Both checks cost money; only the current one counts as a verdict.
    expect(queue.month).toMatchObject({ total: 1, disagrees: 1 });
    expect(queue.month.costUsd).toBeCloseTo(0.0187 * 12);
  });
  it("refuses closers, other tenants' checks and a switched-off second opinion", async () => {
    const f = await answeredCheck("on");
    await expect(f.closer.mutation(api.secondOpinion.rerun, { secondOpinionId: f.id })).rejects.toThrow();
    await f.t.run(async (ctx) => {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      await ctx.db.patch("tenants", f.tenantId, { secondOpinion: { ...tenant!.secondOpinion!, mode: "off" } });
    });
    await expect(f.owner.mutation(api.secondOpinion.rerun, { secondOpinionId: f.id })).rejects.toThrow(
      /can't be run again/,
    );
    const other = await secondOpinionHarness("on");
    await expect(other.owner.mutation(api.secondOpinion.rerun, { secondOpinionId: f.id })).rejects.toThrow();
  });
  it("reruns a skipped check, and explains when there is nothing to check", async () => {
    const f = await heldCallBack(10);
    vi.stubGlobal("fetch", vi.fn(async () => json(decisionsResponse())));
    const id = (await f.queue())!;
    await run(f, id);
    const skipped = await f.admin.query(api.secondOpinion.getForReview, { secondOpinionId: id });
    expect(skipped).toMatchObject({ canRerun: true, opinion: { status: "skipped", failure: "thin_transcript" } });
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, { transcriptDeletedAt: Date.now() }),
    );
    await expect(f.admin.mutation(api.secondOpinion.rerun, { secondOpinionId: id })).rejects.toThrow(
      /nothing to check/,
    );
  });
});
