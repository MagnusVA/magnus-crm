import { secondOpinionHarness } from "./secondOpinionHarness";
import type { Doc } from "../convex/_generated/dataModel";
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

/**
 * One tenant with Second opinion on, one booked meeting nobody recorded a
 * result for, and its matched recording. `settings` switches Call insights on.
 */
export async function callInsightsHarness(
  opts: {
    settings?: Partial<CallInsightsSettings> | null;
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
