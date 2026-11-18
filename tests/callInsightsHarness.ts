import { secondOpinionHarness } from "./secondOpinionHarness";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { CallInsightsSettings } from "../convex/callInsights/validators";
import { initialSettings } from "../convex/callInsights/settings";

/** A made-up call: the prospect states her income, raises her husband, then pays. */
export const PAID_CALL = [
  {
    speaker: "Kim",
    email: "kim@example.com",
    timestamp: "00:00:05",
    text: "Hi Grace, thanks for joining.",
  },
  {
    speaker: "Grace",
    email: "grace@example.com",
    timestamp: "00:01:00",
    text: "I make about six thousand dollars a month from my salon.",
  },
  {
    speaker: "Grace",
    email: "grace@example.com",
    timestamp: "00:05:00",
    text: "I'd need to talk to my husband before I spend that.",
  },
  {
    speaker: "Kim",
    email: "kim@example.com",
    timestamp: "00:20:00",
    text: "The program is 1,700 dollars today.",
  },
  {
    speaker: "Grace",
    email: "grace@example.com",
    timestamp: "00:20:30",
    text: "Okay, let's do it. I'll pay the 1,700 now on my card.",
  },
  {
    speaker: "Kim",
    email: "kim@example.com",
    timestamp: "00:21:00",
    text: "Great.",
  },
];

/** What Claude would answer for PAID_CALL. */
export const PAID_EXTRACTION = {
  items: [
    {
      kind: "objection",
      category: "partner",
      statement: "Needs to talk to her husband before spending.",
      quote: "I'd need to talk to my husband",
      lineIndex: 3,
      resolution: "unresolved",
      resolutionQuote: "",
      resolutionLineIndex: 0,
      scenario: "none",
      amountMin: "",
      amountMax: "",
      currencyAsSaid: "none",
      period: "unknown",
      deadline: "",
    },
    {
      kind: "income",
      category: "personal_income",
      statement: "Earns about 6,000 a month from her salon.",
      quote: "about six thousand dollars a month",
      lineIndex: 2,
      resolution: "none",
      resolutionQuote: "",
      resolutionLineIndex: 0,
      scenario: "current",
      amountMin: "6000",
      amountMax: "6000",
      currencyAsSaid: "dollars_unspecified",
      period: "month",
      deadline: "",
    },
  ],
  primaryBlocker: "partner",
  result: {
    kind: "paid",
    quotes: [
      {
        label: "price",
        quote: "The program is 1,700 dollars today",
        lineIndex: 4,
      },
      {
        label: "agreement",
        quote: "I'll pay the 1,700 now on my card",
        lineIndex: 5,
      },
    ],
    amount: "1700",
    amountRole: "this_payment",
    currencyAsSaid: "dollars_unspecified",
    paymentType: "pif",
    installments: 0,
    programHeard: "",
    callbackDateTimeLocal: "",
    contactMethod: "none",
    lossCategory: "none",
  },
  attendance: { reading: "present", quotes: [], reachOutcome: "none" },
};

export const messagesResponse = (answer: unknown, costUsd = 0.1) =>
  new Response(
    JSON.stringify({
      id: "msg-test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(answer) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5000, output_tokens: 400, cost: costUsd },
    }),
    { status: 200 },
  );

/** Answers a Decisions request: every yes/no question gets `noul`, every choice question its answer. */
export function decisionsAnswer(
  body: { questions: Record<string, { type: string }> },
  opts: {
    noul?: number;
    attendance?: [string, number];
    ending?: [string, number];
    /** Leave `usage.cost` out, as the gateway sometimes does. */
    noCost?: boolean;
  } = {},
) {
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(body.questions)) {
    if (question.type === "noul")
      answers[key] = { type: "noul", noul: opts.noul ?? 0.95 };
    else if (key === "attendance") {
      const [choice, confidence] = opts.attendance ?? ["held", 0.96];
      answers[key] = { choice, confidence };
    } else if (key === "ending") {
      const [choice, confidence] = opts.ending ?? ["paid", 0.9];
      answers[key] = { choice, confidence };
    } else answers[key] = { choice: "none", confidence: 0.9 };
  }
  return new Response(
    JSON.stringify({
      id: "dec-test",
      model: "typesafe/jev-1.13",
      answers,
      usage: {
        input_tokens: 400,
        output_tokens: 20,
        ...(opts.noCost ? {} : { cost: 0.00002 }),
      },
    }),
    { status: 200 },
  );
}

/** A `fetch` that plays the gateway: Claude on /v1/messages, Jev on /alpha/decisions. */
export function gatewayFetch(
  opts: {
    extraction?: unknown;
    messages?: () => Response;
    decisions?: (body: {
      questions: Record<string, { type: string }>;
    }) => Response;
  } = {},
) {
  const calls = { messages: 0, decisions: 0 };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/messages")) {
      calls.messages++;
      return opts.messages
        ? opts.messages()
        : messagesResponse(opts.extraction ?? PAID_EXTRACTION);
    }
    if (url.endsWith("/alpha/decisions")) {
      calls.decisions++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      return opts.decisions ? opts.decisions(body) : decisionsAnswer(body);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

export function callEvidenceSettings(
  ownerId: Id<"users">,
  changedAt: number,
): NonNullable<Doc<"tenants">["resultAutomation"]> {
  const policy = {
    mode: "shadow" as const,
    policyVersion: 1,
    changedAt,
    changedByUserId: ownerId,
  };
  return {
    enabled: true,
    activationVersion: 1,
    changedAt,
    changedByUserId: ownerId,
    kinds: {
      payment_win: policy,
      additional_payment: policy,
      call_back: policy,
    },
  };
}

/**
 * One tenant with Second opinion on, one booked meeting nobody recorded a
 * result for, and its matched recording. `settings` switches Call insights on.
 */
export async function callInsightsHarness(
  opts: {
    settings?: Partial<CallInsightsSettings> | null;
    callEvidence?: boolean;
    transcript?: Array<{
      speaker: string;
      email?: string;
      timestamp: string;
      text: string;
    }>;
    status?: Doc<"meetings">["status"];
  } = {},
) {
  const f = await secondOpinionHarness("on", opts.status ?? "scheduled");
  const transcript = opts.transcript ?? PAID_CALL;
  await f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob([JSON.stringify(transcript)], { type: "application/json" }),
    );
    const recording = await ctx.db.get("callRecordings", f.recordingId);
    await ctx.db.patch("callRecordings", f.recordingId, {
      transcriptStorageId: storageId,
      transcriptLineCount: transcript.length,
      transcriptExpiresAt:
        (recording?.recordingStartAt ?? Date.now()) + 90 * 86_400_000,
      matchMethod: "time_email",
    });
    if (opts.callEvidence)
      await ctx.db.patch("tenants", f.tenantId, {
        resultAutomation: callEvidenceSettings(f.ownerId, Date.now()),
      });
    if (opts.settings !== null)
      await ctx.db.patch("tenants", f.tenantId, {
        callInsights: {
          ...initialSettings(f.ownerId, Date.now() - 7 * 86_400_000),
          ...opts.settings,
        },
      });
  });
  return f;
}

/** A finished extraction ready for the real publishing mutation, with no model or gateway involved. */
export async function seedCallDecisionReading(
  f: Awaited<ReturnType<typeof callInsightsHarness>>,
  options: {
    kind?: "call_back" | "payment_owed" | "refusal_loss";
    trigger?: Doc<"callInsightRuns">["trigger"];
    generation?: number;
    alert?: boolean;
  } = {},
) {
  const kind = options.kind ?? "call_back";
  const generation = options.generation ?? 1;
  const now = Date.now();
  const resultKind = kind === "call_back" ? "call_back" : kind === "payment_owed" ? "promised" : "lost";
  const statementKind = kind === "call_back" ? "asks_call_back" : kind === "payment_owed" ? "promises_payment" : "declines";
  const ending = { choice: resultKind === "promised" ? "paid" : resultKind, confidence: 0.98 };
  const claimToken = "fixture-claim";
  const runId = await f.t.run(async (ctx) => {
    const meeting = (await ctx.db.get("meetings", f.meetingId))!;
    const header = await ctx.db.query("callInsightFacts")
      .withIndex("by_recordingId_and_kind", (q) => q.eq("recordingId", f.recordingId).eq("kind", "call"))
      .first();
    if (!header) {
      await ctx.db.insert("callInsightFacts", {
        kind: "call", tenantId: f.tenantId, meetingId: f.meetingId, recordingId: f.recordingId,
        active: true, publicationRevision: 0, latestStatus: "checking", expectedItemCount: 0,
        scheduledAt: meeting.scheduledAt, createdAt: now, updatedAt: now,
      });
    }
    const quote = {
      quote: "Private statement from Grace, kept only on the reading.",
      speaker: "Prospect" as const, lineIndex: 2, atSeconds: 9,
    };
    const evidence: NonNullable<Doc<"callInsightRuns">["evidence"]> = {
      recordingScope: "whole", scopeLines: [1, 5], closerStance: "continues",
      prospectStance: kind === "refusal_loss" ? "refused" : "yes",
      nextStep: kind === "refusal_loss" ? "none" : kind,
      nextStepAt: now + 48 * 3_600_000,
      nextStepMethod: "call", quotedAmountMinor: 25000, quotedCurrency: "USD",
      statements: [{ ...quote, kind: statementKind, amountMinor: 25000, currency: "USD" }],
      dropped: { quoteNotFound: 0, amountNotInQuote: 0, cardNumber: 0, overLimit: 0 },
    };
    if (options.alert) {
      evidence.statements.push({
        kind: "payment_seen", quote: "Kim confirms this private payment.",
        speaker: "Closer", lineIndex: 4, atSeconds: 10,
      });
    }
    return await ctx.db.insert("callInsightRuns", {
      tenantId: f.tenantId, recordingId: f.recordingId, meetingId: f.meetingId,
      purpose: "serve", generation, trigger: options.trigger ?? "recording_matched", kind: "full",
      status: "checking", attempt: 1, claimToken, inputKey: `c1-test-${generation}`,
      config: {
        model: "anthropic/claude-sonnet-5.5", promptVersion: "p2", thresholdsVersion: "t1",
        taxonomyVersion: "t1", callEvidence: true, itemCheck: true,
      },
      result: { kind: resultKind, codeChecksPassed: true, failedChecks: [], values: {}, quotes: [] },
      evidence, receipts: [], createdAt: now,
    });
  });
  return {
    runId, claimToken, items: [],
    earlyReading: { incomplete: false, ending: { withSummary: ending, withoutSummary: ending } },
    callChecks: {
      version: "cc1", wholeCall: 0.98, refused: kind === "refusal_loss" ? 0.98 : 0.01,
      disqualified: 0.01, nextStep: 0.98, incomplete: false,
    },
    jevCost: { costUsd: 0 },
  };
}

// ─── Automatic call tasks (phase 3, package D2) ─────────────────────────
// Imports for the helpers below; ES modules hoist them.
import { makeFunctionReference as d2FunctionReference } from "convex/server";
import { api as d2Api, internal as d2Internal } from "../convex/_generated/api";
import { currentRuleVersion as d2CurrentRuleVersion } from "../convex/automation/settings";
import {
  insertMeetingAggregate as d2InsertMeetingAggregate, insertOpportunityAggregate as d2InsertOpportunityAggregate,
} from "../convex/reporting/writeHooks";
import { seedAutomaticCertificate as d2SeedAutomaticCertificate } from "./providerPaymentFixtures";

type D2TaskKind = "call_back" | "payment_owed";
const d2EvaluateCallMeeting = d2FunctionReference<"mutation", { meetingId: Id<"meetings">; cause: "published" }, {
  decisionIds: Id<"resultAutomationDecisions">[];
}>("automation/callDecisions:evaluateCallMeeting");

/**
 * The call harness with automation on and the task kind at ask, or promoted
 * to automatic on a certified sample at today's rule version.
 */
export async function callTaskFixture(kind: D2TaskKind, automatic: boolean) {
  const f = await callInsightsHarness();
  // The harness writes its deal and call raw; the cores keep their aggregates.
  await f.t.run(async (ctx) => {
    await d2InsertOpportunityAggregate(ctx, f.opportunityId);
    await d2InsertMeetingAggregate(ctx, f.meetingId);
  });
  await f.owner.mutation(d2Api.automation.settings.setEnabled, { enabled: true });
  await f.owner.mutation(d2Api.automation.settings.setKindMode, { kind, mode: "ask" });
  if (!automatic) return { ...f, sampleId: undefined };
  const ruleVersion = await f.t.run(async (ctx) => d2CurrentRuleVersion((await ctx.db.get("tenants", f.tenantId))!, kind));
  const sampleId = await d2SeedAutomaticCertificate(f.t, {
    tenantId: f.tenantId, promotedByUserId: f.ownerId, kind, ruleVersion, now: Date.now(),
  });
  return { ...f, sampleId };
}

/** Publish a reading of the harness call and evaluate it. Returns the kind's stored decision. */
export async function readCallForTask(
  f: Awaited<ReturnType<typeof callInsightsHarness>>,
  kind: D2TaskKind,
): Promise<Id<"resultAutomationDecisions">> {
  const args = await seedCallDecisionReading(f, { kind });
  await f.t.mutation(d2Internal.callInsights.run.publish, args);
  const { decisionIds } = await f.t.mutation(d2EvaluateCallMeeting, { meetingId: f.meetingId, cause: "published" });
  const rows = await f.t.run(async (ctx) => await Promise.all(decisionIds.map((id) => ctx.db.get("resultAutomationDecisions", id))));
  const decision = rows.find((row) => row?.kind === kind);
  if (!decision) throw new Error(`No ${kind} decision`);
  return decision._id;
}
