import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { callInsightsHarness } from "../../tests/callInsightsHarness";
import { maskEvidenceQuotes } from "./maintenance";
import type { CallEvidence } from "./validators";
import { servingConfig } from "./settings";

vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));
afterEach(() => vi.useRealTimers());

const evidence: CallEvidence = {
  recordingScope: "whole",
  scopeLines: [1, 2, 3],
  statements: [
    {
      kind: "defers",
      quote: "Synthetic deferral phrase",
      lineIndex: 2,
      atSeconds: 60,
      speaker: "Prospect",
    },
    {
      kind: "disqualifies",
      quote: "Synthetic disqualification phrase",
      lineIndex: 3,
      atSeconds: 65,
      speaker: "Closer",
    },
  ],
  prospectStance: "undecided",
  closerStance: "disqualified",
  nextStep: "none",
  dropped: {
    amountNotInQuote: 0,
    cardNumber: 0,
    overLimit: 0,
    quoteNotFound: 0,
  },
};

it("masks evidence at expiry or after purge and scrubs every persisted evidence quote", async () => {
  vi.useFakeTimers();
  const f = await callInsightsHarness({ callEvidence: true });
  const { run, recording } = await f.t.run(async (ctx) => {
    const tenant = await ctx.db.get("tenants", f.tenantId);
    const recording = await ctx.db.get("callRecordings", f.recordingId);
    if (!tenant?.callInsights || !recording) throw new Error("Missing fixture");
    const runId = await ctx.db.insert("callInsightRuns", {
      tenantId: f.tenantId,
      recordingId: f.recordingId,
      meetingId: f.meetingId,
      purpose: "serve",
      generation: 1,
      inputKey: "synthetic-purge",
      trigger: "recording_matched",
      kind: "full",
      status: "answered",
      attempt: 1,
      config: servingConfig(tenant.callInsights, tenant),
      receipts: [],
      evidence,
      createdAt: Date.now(),
    });
    return { run: (await ctx.db.get("callInsightRuns", runId))!, recording };
  });
  expect(maskEvidenceQuotes(run, recording, Date.now())).toEqual(evidence);
  const masked = maskEvidenceQuotes(
    run,
    recording,
    recording.transcriptExpiresAt!,
  );
  const maskedEvidence = {
    ...evidence,
    statements: evidence.statements.map((statement) => ({
      ...statement,
      quote: null,
    })),
  };
  expect(masked).toEqual(maskedEvidence);
  expect(
    maskEvidenceQuotes({ ...run, quotesPurgedAt: 0 }, recording, Date.now()),
  ).toEqual(maskedEvidence);
  expect(maskEvidenceQuotes(run, null, Date.now())).toEqual(maskedEvidence);

  await f.t.mutation(internal.callInsights.maintenance.purgeRecording, {
    recordingId: f.recordingId,
  });
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const purged = (await f.t.run((ctx) =>
    ctx.db.get("callInsightRuns", run._id),
  ))!;
  expect(purged.quotesPurgedAt).toBeDefined();
  expect(purged.evidence).toEqual({
    ...evidence,
    statements: evidence.statements.map((statement) => ({
      ...statement,
      quote: "",
    })),
  });
  const walk = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    for (const [field, nested] of Object.entries(value)) {
      if (field === "quote") expect(nested).toBe("");
      else walk(nested);
    }
  };
  walk(purged);
  const serialized = JSON.stringify(purged);
  for (const statement of evidence.statements)
    expect(serialized).not.toContain(statement.quote);
});
