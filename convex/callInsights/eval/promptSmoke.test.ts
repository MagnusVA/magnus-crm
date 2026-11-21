import { anyApi, type ApiFromModules } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callInsightsHarness,
  decisionsAnswer,
  messagesResponse,
} from "../../../tests/callInsightsHarness";
import { flatAnswer } from "../../../tests/callInsightsFlat";
import {
  evidenceAnswer,
  EVIDENCE_FIXTURES,
  INVITEES,
  RECORDER,
  SYNTHETIC_FIXTURES,
} from "../../../tests/callInsights/synthetic/fixtures";
import {
  parseStoredTranscript,
  prepareTranscript,
  renderLines,
} from "../transcriptPrep";
import type * as smoke from "./promptSmoke";

const internal = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/promptSmoke": typeof smoke;
  }>
).callInsights.eval.promptSmoke;
const devUrl = "https://cautious-donkey-511.convex.cloud";
const callFixtures = [...SYNTHETIC_FIXTURES, ...EVIDENCE_FIXTURES];

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "smoke-test-token"),
}));
vi.mock("../../auth", () => ({ authKit: { registerRoutes: () => {} } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mockEvidence = new Map(
  EVIDENCE_FIXTURES.map((fixture) => {
    const transcript = prepareTranscript(
      parseStoredTranscript(fixture.transcript),
      RECORDER,
      INVITEES,
    );
    return [renderLines(transcript.lines), fixture.evidence];
  }),
);

describe("dev prompt smoke", () => {
  it.each([undefined, "https://production.example.test"])(
    "refuses an unapproved deployment URL %s before reservations or requests",
    async (url) => {
      vi.stubEnv("CONVEX_CLOUD_URL", url);
      const f = await callInsightsHarness();
      const gateway = vi.fn();
      vi.stubGlobal("fetch", gateway);
      await expect(
        f.t.action(internal.run, { tenantId: f.tenantId }),
      ).rejects.toThrow("requires the dev deployment");
      expect(gateway).not.toHaveBeenCalled();
      expect(
        await f.t.run((ctx) => ctx.db.query("callInsightBudgets").first()),
      ).toBeNull();
    },
  );

  it("reserves before each request and returns counts for 20 fixtures only", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", devUrl);
    const f = await callInsightsHarness({ settings: { evalMonthlyUsd: 20 } });
    const counts = { p1: 0, p2: 0, call: 0, step: 0 };
    const observedReserves: number[] = [];
    const outputMarker = "model statements stay private";
    let firstP2 = true;
    const gateway = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const row = await f.t.run((ctx) =>
          ctx.db.query("callInsightBudgets").first(),
        );
        observedReserves.push(row?.evalReservedMicroUsd ?? 0);
        const body = JSON.parse(String(init?.body));
        if (String(input).endsWith("/alpha/decisions")) {
          if (body.questions.whole_call) counts.call++;
          else if (body.questions.next_step) counts.step++;
          else return new Response("unexpected check", { status: 400 });
          return decisionsAnswer(body);
        }
        if (!String(input).endsWith("/v1/messages"))
          return new Response(null, { status: 404 });
        const answer = flatAnswer({ primaryBlocker: outputMarker });
        const p2 = !!body.output_config.format.schema.properties.evidence;
        if (!p2) {
          counts.p1++;
          return messagesResponse(answer, 0.025);
        }
        counts.p2++;
        const message = body.messages[0].content;
        const evidence =
          [...mockEvidence].find(([rendered]) =>
            message.includes(rendered),
          )?.[1] ?? evidenceAnswer({});
        // One rejected schema must not count as accepted or as a matching result.
        if (firstP2) {
          firstP2 = false;
          return new Response(outputMarker, { status: 400 });
        }
        return messagesResponse({ ...answer, evidence }, 0.025);
      },
    );
    vi.stubGlobal("fetch", gateway);
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const summary = await f.t.action(internal.run, { tenantId: f.tenantId });
    expect(counts).toEqual({ p1: 60, p2: 60, call: 60, step: 60 });
    expect(observedReserves).toHaveLength(240);
    expect(Math.min(...observedReserves)).toBeGreaterThanOrEqual(20_000);
    expect(summary.fixtures).toHaveLength(20);
    expect(summary.budgetExhausted).toBe(false);
    expect(
      summary.fixtures.every(
        (row, i) =>
          row.fixture === i + 1 &&
          row.p1SchemaAccepted === 3 &&
          row.resultKindEqual === row.p2SchemaAccepted &&
          row.resultEqual === row.p2SchemaAccepted &&
          row.p2SchemaAccepted >= 2 &&
          row.callChecksAccepted === 3 &&
          row.evidenceMet === row.evidenceExpected,
      ),
    ).toBe(true);
    expect(
      summary.fixtures.reduce((n, row) => n + row.p2SchemaAccepted, 0),
    ).toBe(59);
    const serialized = JSON.stringify([
      summary,
      log.mock.calls,
      warn.mock.calls,
      error.mock.calls,
    ]);
    for (const fixture of callFixtures) {
      expect(serialized).not.toContain(fixture.name);
      for (const line of fixture.transcript)
        expect(serialized).not.toContain(
          JSON.stringify(line.text).slice(1, -1),
        );
    }
    expect(serialized).not.toContain(outputMarker);
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightBudgets").first()),
    ).toMatchObject({
      evalReservedMicroUsd: 0,
      evalSpentMicroUsd: expect.any(Number),
    });
  });

  it("settles admitted requests and stops when the eval allowance runs out", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", devUrl);
    const f = await callInsightsHarness({ settings: { evalMonthlyUsd: 0.11 } });
    const gateway = vi.fn(async () => {
      // No known price means the request settles at the worst case.
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(flatAnswer({})) }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", gateway);
    const summary = await f.t.action(internal.run, { tenantId: f.tenantId });
    expect(summary.budgetExhausted).toBe(true);
    expect(gateway).toHaveBeenCalledTimes(1);
    const budget = await f.t.run((ctx) =>
      ctx.db.query("callInsightBudgets").first(),
    );
    expect(budget?.evalReservedMicroUsd).toBe(0);
    expect(budget?.evalSpentMicroUsd).toBeGreaterThanOrEqual(90_000);
    expect(budget?.evalSpentMicroUsd).toBeLessThanOrEqual(110_000);
  });

  it("closes an interrupted request's reservation at the maximum cost", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", devUrl);
    vi.useFakeTimers();
    const f = await callInsightsHarness();
    const budget = () =>
      f.t.run((ctx) => ctx.db.query("callInsightBudgets").first());
    await f.t.mutation(internal.reserveRequest, {
      tenantId: f.tenantId,
      origin: "jev_reading",
      amountMicroUsd: 20_000,
      now: Date.now(),
      secondOpinionSpentUsd: 0,
    });
    expect(await budget()).toMatchObject({
      evalReservedMicroUsd: 20_000,
      evalSpentMicroUsd: 0,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await budget()).toMatchObject({
      evalReservedMicroUsd: 0,
      evalSpentMicroUsd: 20_000,
    });
  });
});
