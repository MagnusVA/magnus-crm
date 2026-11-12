import { anyApi, getServiceToken, type ApiFromModules } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  committedCase,
  createCase,
  evalHarness,
  api as human,
} from "../../../tests/callInsights/synthetic/evalHarness";
import {
  messagesResponse,
  PAID_CALL,
} from "../../../tests/callInsightsHarness";
import * as judgeModule from "./judge";
import { calibration } from "./judge";
import {
  GRADING_SCHEMA,
  INVENTORY_SCHEMA,
  GRADING_SYSTEM,
  INVENTORY_SYSTEM,
  describeCandidate,
  parseGrades,
  parseInventory,
} from "./judgePrompt";
import {
  GOAL_CATEGORIES,
  OBJECTION_CATEGORIES,
  STRUGGLE_CATEGORIES,
} from "../../../lib/callInsights/taxonomy";
const api = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/judge": typeof judgeModule;
  }>
).callInsights.eval.judge;
vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../../auth", () => ({ authKit: { registerRoutes: () => {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const inventory = {
  items: [
    {
      itemClass: "objection",
      category: "partner",
      lineStart: 3,
      lineEnd: 3,
      scenario: "none",
      amountMin: 0,
      amountMax: 0,
      currencyAsSaid: "none",
      period: "unknown",
      resolution: "unresolved",
    },
  ],
  result: {
    kind: "paid",
    amount: 1700,
    currencyAsSaid: "dollars_unspecified",
    callbackDateTimeLocal: "",
    lossCategory: "none",
  },
  attendance: "present",
};
type Harness = Awaited<ReturnType<typeof evalHarness>>;
const labels = (f: Harness) =>
  f.t.run((ctx) => ctx.db.query("callInsightEvalLabels").take(200));
const runs = (f: Harness) =>
  f.t.run((ctx) => ctx.db.query("callInsightRuns").take(100));
function stubJudge(
  opts: { busyAt?: number; failure?: unknown; missingUsage?: boolean } = {},
) {
  const requests: Array<{
    system: string;
    model: string;
    max_tokens: number;
    messages: Array<{ content: string }>;
    output_config: { effort: string };
    provider: unknown;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (requests.length === opts.busyAt)
        return new Response("busy", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      const answer =
        opts.failure ??
        (body.system === INVENTORY_SYSTEM
          ? inventory
          : {
              grades: String(body.messages[0].content)
                .split("\n")
                .filter((l) =>
                  /^#\d+ (?:objection|income|result|attendance|goal|struggle) ·/.test(
                    l,
                  ),
                )
                .map((l) => ({
                  n: Number(l.match(/^#(\d+)/)![1]),
                  verdict: l.includes("income ·")
                    ? "contradicted"
                    : "supported",
                  wrongFields: l.includes("income ·") ? "amount" : "",
                  lines: l.includes("objection ·") ? "3" : "2",
                })),
            });
      if (opts.missingUsage)
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify(answer) }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      return messagesResponse(answer, 0.01);
    }),
  );
  return requests;
}
async function fixture() {
  const canary = "PRIVATE CANARY this must never be stored by a judge";
  const f = await evalHarness({
    transcript: [...PAID_CALL.slice(0, 5), { ...PAID_CALL[5], text: canary }],
  });
  const c = await committedCase(f);
  await f.t.run((ctx) =>
    ctx.db.insert("callInsightEvalLabels", {
      tenantId: f.tenantId,
      caseId: c.caseId,
      source: "extractor",
      itemClass: "income",
      itemKey: "income:0",
      category: "personal_income",
      scenario: "current",
      minMinor: 600000,
      maxMinor: 600000,
      currency: "USD",
      period: "month",
      lineStart: 2,
      adminVerdict: "wrong",
      wrongFields: ["minMinor"],
      labelRevision: 1,
      createdAt: Date.now(),
    }),
  );
  return { f, c, canary };
}
describe("judge requests and storage", () => {
  it("binds shuffled and reversed numbers to the right labels, stores plants and inventory, and settles the eval pool", async () => {
    const { f, c, canary } = await fixture();
    const requests = stubJudge();
    const jobId = await f.owner.mutation(api.startJudgeJob, {
      campaign: c.campaign,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({
        model: "anthropic/claude-opus-5.5",
        max_tokens: 8000,
        output_config: { effort: "medium" },
        provider: {
          zdr: true,
          data_collection: "deny",
          require_parameters: true,
        },
      });
      expect(request.messages[0].content).not.toContain(
        "Needs partner agreement",
      );
    }
    const candidateLines = (request: (typeof requests)[number]) =>
      request.messages[0].content
        .split("\n")
        .filter((l) =>
          /^#\d+ (?:objection|income|result|attendance|goal|struggle) ·/.test(
            l,
          ),
        )
        .map((l) => l.replace(/^#\d+ /, ""));
    expect(candidateLines(requests[1]).reverse()).toEqual(
      candidateLines(requests[2]),
    );
    const stored = await labels(f);
    expect(stored.filter((l) => l.source === "planted")).toHaveLength(2);
    expect(stored.filter((l) => l.source === "inventory")).toHaveLength(3);
    for (const l of stored.filter(
      (l) => l.source === "extractor" || l.source === "planted",
    )) {
      expect(l.judgeVerdict).toBe(
        l.itemClass === "income" ? "contradicted" : "supported",
      );
      expect(l.judgeRerunVerdict).toBe(l.judgeVerdict);
      expect(l.judgeWrongFields).toEqual(
        l.itemClass === "income" ? ["amount"] : [],
      );
    }
    const judgeRuns = (await runs(f)).filter((r) => r.purpose === "eval");
    expect(judgeRuns).toHaveLength(3);
    expect(
      judgeRuns.every(
        (r) =>
          r.status === "answered" &&
          r.generation === 0 &&
          r.receipts.every(
            (p) => p.pool === "eval" && p.settledAt !== undefined,
          ),
      ),
    ).toBe(true);
    expect(JSON.stringify(await runs(f))).not.toContain(canary);
    expect(JSON.stringify(stored)).not.toContain(canary);
    expect(
      await f.t.run((ctx) => ctx.db.query("callInsightBudgets").first()),
    ).toMatchObject({
      reservedMicroUsd: 0,
      evalReservedMicroUsd: 0,
      evalSpentMicroUsd: 30000,
    });
    expect(
      await f.t.run((ctx) => ctx.db.get("callInsightJobs", jobId!)),
    ).toMatchObject({
      status: "done",
      done: 1,
      failed: 0,
      spentMicroUsd: 30000,
    });
    const before = JSON.stringify(await labels(f));
    await f.t.action(api.judgeCase, {
      caseId: c.caseId,
      jobId: jobId!,
      jobItemId: (await f.t.run((ctx) =>
        ctx.db.query("callInsightJobItems").first(),
      ))!._id,
    });
    expect(JSON.stringify(await labels(f))).toBe(before);
    expect(requests).toHaveLength(3);
    expect(getServiceToken).toHaveBeenCalled();
  });
  it("skips an item without judging anything when the eval reservation cannot fit", async () => {
    const { f, c } = await fixture();
    await f.t.run(async (ctx) => {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      await ctx.db.patch("tenants", f.tenantId, {
        callInsights: { ...tenant!.callInsights!, monthlyCapUsd: 40 },
      });
    });
    const requests = stubJudge();
    const jobId = await f.owner.mutation(api.startJudgeJob, {
      campaign: c.campaign,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(0);
    expect(
      (await labels(f)).every(
        (l) =>
          !l.judgeVerdict && l.source !== "inventory" && l.source !== "planted",
      ),
    ).toBe(true);
    expect(
      await f.t.run((ctx) => ctx.db.get("callInsightJobs", jobId!)),
    ).toMatchObject({ status: "done", skipped: 1, done: 0 });
    expect((await runs(f)).find((r) => r.purpose === "eval")).toMatchObject({
      status: "skipped",
      reason: "cap_reached",
      receipts: [],
    });
  });
  it("retries only the busy phase and reuses the completed inventory", async () => {
    const { f, c } = await fixture();
    const requests = stubJudge({ busyAt: 2 });
    await f.t.action(api.judgeCase, { caseId: c.caseId });
    const queued = (await runs(f)).find((r) => r.status === "queued");
    expect(queued).toMatchObject({
      attempt: 1,
      nextAttemptAt: Date.now() + 120000,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests).toHaveLength(4);
    expect((await runs(f)).find((r) => r.evalRole === "judge")?.attempt).toBe(
      2,
    );
    expect(
      (await labels(f)).find((l) => l.itemKey === "income:0")?.judgeVerdict,
    ).toBe("contradicted");
  });
  it("fails a malformed answer privately, settles its bill, and stores no grades", async () => {
    const { f, c, canary } = await fixture();
    stubJudge({ failure: { text: canary } });
    await f.t.action(api.judgeCase, { caseId: c.caseId });
    const run = (await runs(f)).find((r) => r.purpose === "eval");
    expect(run).toMatchObject({ status: "failed", reason: "format_changed" });
    expect(run?.receipts[0].spentMicroUsd).toBe(10000);
    expect(JSON.stringify(run)).not.toContain(canary);
    expect((await labels(f)).some((l) => l.judgeVerdict)).toBe(false);
  });
  it("settles missing usage at the full reservation", async () => {
    const { f, c } = await fixture();
    stubJudge({ missingUsage: true });
    await f.t.action(api.judgeCase, { caseId: c.caseId });
    for (const r of (await runs(f)).filter((r) => r.purpose === "eval"))
      expect(r.receipts[0].spentMicroUsd).toBe(r.receipts[0].reservedMicroUsd);
  });
  it("does not judge uncommitted dev cases or allow closers to start jobs", async () => {
    const f = await evalHarness(),
      c = await createCase(f),
      requests = stubJudge();
    await f.t.action(api.judgeCase, { caseId: c.caseId });
    expect(requests).toHaveLength(0);
    await expect(
      f.closer.mutation(api.startJudgeJob, { campaign: c.campaign }),
    ).rejects.toThrow();
    await expect(
      f.closer.query(api.judgeCalibration, { campaign: c.campaign }),
    ).rejects.toThrow();
    await f.owner.mutation(human.labels.commitList, {
      caseId: c.caseId,
      skipped: true,
    });
    await f.t.action(api.judgeCase, { caseId: c.caseId });
    expect(requests).toHaveLength(0);
  });
});
function inspectSchema(value: unknown) {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.type === "object") {
    expect(node.additionalProperties).toBe(false);
    expect(node.required).toEqual(Object.keys(node.properties as object));
  }
  Object.values(node).forEach(inspectSchema);
}
describe("judge schemas and privacy", () => {
  it.each([INVENTORY_SCHEMA, GRADING_SCHEMA])(
    "has closed objects, every field required, and no nullable field",
    (schema) => {
      inspectSchema(schema);
      expect(JSON.stringify(schema)).not.toContain("anyOf");
      expect(JSON.stringify(schema)).not.toContain('"null"');
    },
  );
  it("embeds the extractor taxonomy and treats transcript instructions as untrusted", () => {
    for (const table of [
      GOAL_CATEGORIES,
      OBJECTION_CATEGORIES,
      STRUGGLE_CATEGORIES,
    ])
      for (const [key, value] of Object.entries(table))
        expect(INVENTORY_SYSTEM).toContain(`${key}: ${value.definition}`);
    expect(GRADING_SYSTEM).toContain("untrusted data");
    expect(INVENTORY_SYSTEM).toContain("untrusted data");
    expect(
      describeCandidate(
        {
          key: "PRIVATE",
          itemClass: "objection",
          category: "PRIVATE",
          lineStart: 2,
        },
        1,
      ),
    ).not.toContain("PRIVATE");
  });
  it("rejects prose, duplicate numbers, missing grades and invalid citations", () => {
    for (const grades of [
      [],
      [{ n: 1, verdict: "supported", wrongFields: "", lines: "" }],
      [
        {
          n: 1,
          verdict: "supported",
          wrongFields: "private quote",
          lines: "2",
        },
      ],
      [{ n: 1, verdict: "supported", wrongFields: "", lines: "99" }],
    ])
      expect(() => parseGrades(JSON.stringify({ grades }), 1, 6)).toThrow(
        "Call insights response has an invalid format",
      );
    expect(() =>
      parseInventory(
        JSON.stringify({
          ...inventory,
          items: [{ ...inventory.items[0], category: "PRIVATE" }],
        }),
        6,
      ),
    ).toThrow();
    expect(parseInventory(JSON.stringify(inventory), 6)).not.toHaveProperty(
      "result.callbackDateTimeLocal",
    );
  });
});
function label(
  n: number,
  patch: Partial<Doc<"callInsightEvalLabels">>,
): Doc<"callInsightEvalLabels"> {
  return {
    _id: `label-${n}` as Id<"callInsightEvalLabels">,
    _creationTime: 0,
    tenantId: "tenant" as Id<"tenants">,
    caseId: "case" as Id<"callInsightEvalCases">,
    source: "extractor",
    itemClass: "objection",
    adminVerdict: "right",
    judgeVerdict: "supported",
    judgeRerunVerdict: "supported",
    labelRevision: 1,
    createdAt: 0,
    ...patch,
  };
}
describe("calibration", () => {
  it("uses whole-call agreement, exact bounds, plants, stability, and excludes exposed cases", () => {
    const rows: judgeModule.CalibrationCase[] = Array.from(
      { length: 29 },
      (_, i) => ({
        case: {
          groupKey: `${i}`,
          split: "calib",
          status: "labels_committed",
          judgeExposed: false,
        },
        labels: [
          label(i, {}),
          label(i + 100, { itemClass: "income" }),
          label(i + 200, { itemClass: "result" }),
          label(i + 300, { itemClass: "attendance" }),
          label(i + 400, {
            source: "planted",
            itemClass: "income",
            plantedDefect: "swapped_amount",
            judgeVerdict: "contradicted",
            judgeRerunVerdict: "contradicted",
          }),
        ],
      }),
    );
    let output = calibration(rows);
    expect(
      output.dimensions.find((d) => d.dimension === "objection"),
    ).toMatchObject({
      calls: 29,
      agreement: 29,
      trust: "may_block",
      stability: 1,
    });
    expect(output.dimensions[0].lowerBound).toBeCloseTo(
      Math.pow(0.05, 1 / 29),
      10,
    );
    for (const dimension of ["income", "result", "attendance"])
      expect(
        output.dimensions.find((d) => d.dimension === dimension)?.trust,
      ).toBe("advisory");
    rows[0].labels.push(
      label(999, {
        adminVerdict: "wrong",
        judgeVerdict: "supported",
        judgeRerunVerdict: "contradicted",
      }),
    );
    output = calibration(rows);
    expect(output.dimensions[0]).toMatchObject({
      calls: 29,
      agreement: 28,
      trust: "advisory",
      stable: 29,
      stabilityN: 30,
    });
    rows[0].case.judgeExposed = true;
    expect(calibration(rows).dimensions[0]).toMatchObject({
      calls: 28,
      agreement: 28,
      trust: "advisory",
    });
  });
  it("hand counts inventory-found and shared misses without reusing an inventory item", () => {
    const output = calibration([
      {
        case: {
          groupKey: "one",
          split: "calib",
          status: "closed",
          judgeExposed: false,
        },
        labels: [
          label(1, { source: "admin", category: "price", lineStart: 2 }),
          label(2, { source: "admin", category: "price", lineStart: 3 }),
          label(3, { source: "admin", category: "partner", lineStart: 9 }),
          label(4, { source: "inventory", category: "price", lineStart: 2 }),
          label(5, {
            adminVerdict: "wrong",
            judgeVerdict: "insufficient",
            judgeRerunVerdict: "insufficient",
          }),
        ],
      },
    ]);
    expect(output.inventoryMisses).toEqual({ found: 1, shared: 2 });
    expect(output.dimensions[0]).toMatchObject({ calls: 1, agreement: 1 });
  });
});
