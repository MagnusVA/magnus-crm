import { anyApi, getServiceToken, type ApiFromModules } from "convex/server";
import { v, type Infer } from "convex/values";
import type * as smokeModule from "./promptSmoke";
import type { Id } from "../../_generated/dataModel";
import {
  env,
  internalAction,
  internalMutation,
  type ActionCtx,
} from "../../_generated/server";
import {
  EVIDENCE_FIXTURES,
  INVITEES,
  NOW,
  RECORDER,
  SCHEDULED_AT,
  SYNTHETIC_FIXTURES,
} from "../../../tests/callInsights/synthetic/fixtures";
import { reserve, secondOpinionSpendUsd, settle } from "../budget";
import {
  buildCallCheckRequests,
  CALL_CHECK_MICRO_USD,
  callCheckProposal,
} from "../callChecks";
import { callGenericDecisions } from "../decisions";
import {
  buildMessagesRequest,
  callMessages,
  maxCostMicroUsd,
} from "../gateway";
import { parseExtraction } from "../parse";
import {
  buildUserMessage,
  extractionSchema,
  extractionSystem,
} from "../prompt";
import { LEASE_MS, MAX_OUTPUT_TOKENS } from "../run";
import { effectiveSettings } from "../settings";
import {
  parseStoredTranscript,
  prepareTranscript,
  renderLines,
} from "../transcriptPrep";
import { validateEvidence, validateExtraction } from "../validate";
import {
  DEFAULT_EXTRACTION_MODEL,
  EVIDENCE_PROMPT_VERSION,
  PROMPT_VERSION,
  receiptValidator,
  type CallEvidence,
} from "../validators";

const smoke = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/promptSmoke": typeof smokeModule;
  }>
).callInsights.eval.promptSmoke;

// The platform URL is deployment-specific. Use the project's designated cloud dev.
const DEV_DEPLOYMENT_URL = "https://cautious-donkey-511.convex.cloud";
function requireDevDeployment() {
  if (env.CONVEX_CLOUD_URL !== DEV_DEPLOYMENT_URL)
    throw new Error("Call insights prompt smoke requires the dev deployment.");
}

const tenantArg = { tenantId: v.id("tenants") };
const reservationValidator = v.object({
  receipt: receiptValidator,
  fallbackId: v.id("_scheduled_functions"),
});
export const reserveRequest = internalMutation({
  args: {
    ...tenantArg,
    origin: v.union(v.literal("claude"), v.literal("jev_reading")),
    amountMicroUsd: v.number(),
    now: v.number(),
    secondOpinionSpentUsd: v.number(),
  },
  returns: v.union(reservationValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof reservationValidator> | null> => {
    requireDevDeployment();
    const tenant = await ctx.db.get("tenants", args.tenantId);
    const settings = effectiveSettings(tenant);
    if (!tenant || !settings || settings.evalMonthlyUsd <= 0) return null;
    const receipt = await reserve(ctx, {
      tenant,
      settings,
      key: args.origin,
      origin: args.origin,
      pool: "eval",
      amountMicroUsd: args.amountMicroUsd,
      now: args.now,
      secondOpinionSpentUsd: args.secondOpinionSpentUsd,
    });
    if (!receipt) return null;
    // Reconcile an interrupted smoke action at the full reservation once its
    // action deadline has passed. Normal settlement cancels this fallback.
    const fallbackId = await ctx.scheduler.runAfter(
      LEASE_MS + 60_000,
      smoke.settleRequest,
      { tenantId: args.tenantId, receipt },
    );
    return { receipt, fallbackId };
  },
});

export const settleRequest = internalMutation({
  args: {
    ...tenantArg,
    receipt: receiptValidator,
    costUsd: v.optional(v.number()),
    fallbackId: v.optional(v.id("_scheduled_functions")),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { tenantId, receipt, costUsd, fallbackId },
  ): Promise<null> => {
    requireDevDeployment();
    if (fallbackId) {
      const fallback = await ctx.db.system.get(
        "_scheduled_functions",
        fallbackId,
      );
      if (fallback?.state.kind !== "pending") return null;
      await ctx.scheduler.cancel(fallbackId);
    }
    await settle(ctx, {
      tenantId,
      receipts: [receipt],
      costs: { [receipt.key]: { costUsd } },
      now: Date.now(),
    });
    return null;
  },
});

type GatewayResult = {
  kind: string;
  costUsd?: number;
  status?: number;
};

function metExpectations(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => metExpectations(actual[i], value))
    );
  if (expected === null || typeof expected !== "object")
    return actual === expected;
  if (actual === null || typeof actual !== "object" || Array.isArray(actual))
    return false;
  return Object.entries(expected).every(([key, value]) =>
    metExpectations((actual as Record<string, unknown>)[key], value),
  );
}

const FIXTURES = [
  ...SYNTHETIC_FIXTURES.map(({ transcript }) => ({
    transcript,
    readAt: NOW,
    expectedEvidence: undefined,
  })),
  ...EVIDENCE_FIXTURES.map(({ transcript, readAt, expected }) => ({
    transcript,
    readAt: readAt ?? NOW,
    expectedEvidence: expected,
  })),
];
type Fixture = (typeof FIXTURES)[number];
type PromptVersion = typeof PROMPT_VERSION | typeof EVIDENCE_PROMPT_VERSION;
const REPETITIONS = 3;
const PARALLEL_FIXTURES = 6;
const timeContext = {
  timeZone: "America/Tegucigalpa",
  callDateIso: "2026-11-10",
};
const getToken = () => getServiceToken("ai-gateway");
const fixtureSummary = v.object({
  fixture: v.number(),
  resultKindEqual: v.number(),
  resultEqual: v.number(),
  evidenceExpected: v.number(),
  evidenceMet: v.number(),
  p1SchemaAccepted: v.number(),
  p2SchemaAccepted: v.number(),
  callChecksAccepted: v.number(),
});
const smokeSummary = v.object({
  budgetExhausted: v.boolean(),
  fixtures: v.array(fixtureSummary),
});

function meteredGateway(ctx: ActionCtx, tenantId: Id<"tenants">) {
  let budgetExhausted = false;
  return {
    exhausted: () => budgetExhausted,
    async call<T extends GatewayResult>(
      origin: "claude" | "jev_reading",
      amountMicroUsd: number,
      request: () => Promise<T>,
    ): Promise<T | null> {
      if (budgetExhausted) return null;
      const now = Date.now();
      const secondOpinionSpentUsd = await secondOpinionSpendUsd(
        ctx,
        tenantId,
        now,
      );
      if (budgetExhausted) return null;
      const reservation = await ctx.runMutation(smoke.reserveRequest, {
        tenantId,
        origin,
        amountMicroUsd,
        now,
        secondOpinionSpentUsd,
      });
      if (!reservation) {
        budgetExhausted = true;
        return null;
      }
      let response: T | undefined;
      try {
        response = await request();
        return response;
      } finally {
        // Explicit gateway errors were not billed. A missing response or
        // unusable billed response keeps the full reserve when cost is unknown.
        const unbilled =
          response?.kind === "rejected" ||
          (response?.kind === "busy" && !!response.status);
        await ctx.runMutation(smoke.settleRequest, {
          tenantId,
          ...reservation,
          costUsd: unbilled ? 0 : response?.costUsd,
        });
      }
    },
  };
}

async function runFixture(
  gateway: ReturnType<typeof meteredGateway>,
  fixture: Fixture,
  index: number,
): Promise<Infer<typeof fixtureSummary>> {
  const summary = {
    fixture: index + 1,
    resultKindEqual: 0,
    resultEqual: 0,
    evidenceExpected: fixture.expectedEvidence ? REPETITIONS : 0,
    evidenceMet: 0,
    p1SchemaAccepted: 0,
    p2SchemaAccepted: 0,
    callChecksAccepted: 0,
  };
  const transcript = prepareTranscript(
    parseStoredTranscript(fixture.transcript),
    RECORDER,
    INVITEES,
  );
  const user = buildUserMessage({
    rendered: renderLines(transcript.lines),
    scheduledStartOffsetSeconds: 0,
    todayIso: timeContext.callDateIso,
    timeZone: timeContext.timeZone,
  });
  const callEndedAt =
    SCHEDULED_AT + (transcript.lines.at(-1)?.atSeconds ?? 0) * 1000;
  const extract = async (version: PromptVersion) => {
    const system = extractionSystem(version);
    const schema = extractionSchema(version);
    const request = buildMessagesRequest({
      model: DEFAULT_EXTRACTION_MODEL,
      system,
      user,
      schema,
      maxTokens: MAX_OUTPUT_TOKENS,
      effort: "low",
    });
    const inputTokens = Math.max(
      5_000,
      Math.ceil(
        (system.length + user.length + JSON.stringify(schema).length) / 3,
      ),
    );
    const response = await gateway.call(
      "claude",
      maxCostMicroUsd(DEFAULT_EXTRACTION_MODEL, inputTokens, MAX_OUTPUT_TOKENS),
      () => callMessages(request, getToken),
    );
    if (response?.kind !== "ok") return null;
    try {
      const raw = parseExtraction(
        response.text,
        version === EVIDENCE_PROMPT_VERSION,
      );
      const { result } = validateExtraction(raw, transcript, {
        timeZone: timeContext.timeZone,
        now: fixture.readAt,
      });
      return {
        result,
        evidence: raw.evidence
          ? validateEvidence(raw.evidence, transcript, {
              ...timeContext,
              callEndedAt,
            })
          : undefined,
      };
    } catch {
      // Parsing can fail with model text in the exception. Count it only.
      return null;
    }
  };
  const emptyEvidence: CallEvidence = {
    recordingScope: "unknown",
    scopeLines: [],
    statements: [],
    prospectStance: "unknown",
    closerStance: "unknown",
    nextStep: "unknown",
    dropped: {
      quoteNotFound: 0,
      amountNotInQuote: 0,
      cardNumber: 0,
      overLimit: 0,
    },
  };
  for (
    let repetition = 0;
    repetition < REPETITIONS && !gateway.exhausted();
    repetition++
  ) {
    const p1 = await extract(PROMPT_VERSION);
    if (p1) summary.p1SchemaAccepted++;
    if (gateway.exhausted()) break;
    const p2 = await extract(EVIDENCE_PROMPT_VERSION);
    if (p2?.evidence) {
      summary.p2SchemaAccepted++;
      if (
        fixture.expectedEvidence &&
        metExpectations(p2.evidence, fixture.expectedEvidence)
      )
        summary.evidenceMet++;
    }
    if (p1 && p2?.evidence && p1.result.kind === p2.result.kind) {
      summary.resultKindEqual++;
      if (JSON.stringify(p1.result.values) === JSON.stringify(p2.result.values))
        summary.resultEqual++;
    }
    const evidence = p2?.evidence ?? emptyEvidence;
    const [call, proposedStep] = buildCallCheckRequests({
      evidence,
      lines: transcript.lines,
      proposal: callCheckProposal(evidence),
      timeContext,
    });
    // Serving checks the exact proposal only when it has one. Smoke still
    // exercises the second request shape on every p2 attempt.
    const step = proposedStep?.request ?? {
      state: call.request.state,
      questions: {
        next_step: {
          type: "noul" as const,
          instructions:
            "Did the call end without a call-back or payment commitment with a definite date and time?",
        },
      },
    };
    const callAnswer = await gateway.call(
      "jev_reading",
      CALL_CHECK_MICRO_USD,
      () => callGenericDecisions(call.request, getToken),
    );
    const stepAnswer = await gateway.call(
      "jev_reading",
      CALL_CHECK_MICRO_USD,
      () => callGenericDecisions(step, getToken),
    );
    if (callAnswer?.kind === "ok" && stepAnswer?.kind === "ok")
      summary.callChecksAccepted++;
  }
  return summary;
}

export const run = internalAction({
  args: tenantArg,
  returns: smokeSummary,
  handler: async (ctx, { tenantId }): Promise<Infer<typeof smokeSummary>> => {
    requireDevDeployment();
    const gateway = meteredGateway(ctx, tenantId);
    const fixtures: Infer<typeof fixtureSummary>[] = [];
    for (let start = 0; start < FIXTURES.length; start += PARALLEL_FIXTURES) {
      const batch = FIXTURES.slice(start, start + PARALLEL_FIXTURES);
      const summaries = await Promise.all(
        batch.map((fixture, i) => runFixture(gateway, fixture, start + i)),
      );
      fixtures.push(...summaries);
    }
    return { budgetExhausted: gateway.exhausted(), fixtures };
  },
});
