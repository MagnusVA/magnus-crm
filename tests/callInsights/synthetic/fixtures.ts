import { flatAnswer } from "../../callInsightsFlat";
import type {
  EarlyReading,
  InsightItem,
  SuggestionValues,
} from "../../../convex/callInsights/validators";
import type {
  NoShowTier,
  SuggestionKind,
  SuggestionTier,
} from "../../../lib/callInsights/taxonomy";

/** All dialogue below was made up for these tests. No customer transcript is used. */
export const SCHEDULED_AT = Date.parse("2026-11-10T18:00:00Z");
export const NOW = SCHEDULED_AT + 3 * 3600000;
export const RECORDER = { email: "eli@example.test", names: ["Eli Hart"] };
export const INVITEES = ["aster@example.test"];
type Line = { speaker: string; email: string; timestamp: string; text: string };
const closer = (timestamp: string, text: string): Line => ({
  speaker: "Eli Hart",
  email: RECORDER.email,
  timestamp,
  text,
});
const prospect = (timestamp: string, text: string): Line => ({
  speaker: "Aster Quill",
  email: INVITEES[0],
  timestamp,
  text,
});
const opening = closer("00:00:00", "Hello Aster, what would help today?");
const reading = (ending = "paid", attendance = "held"): EarlyReading => ({
  ending: {
    withSummary: { choice: ending, confidence: 0.96 },
    withoutSummary: { choice: ending, confidence: 0.96 },
  },
  attendance: {
    withSummary: { choice: attendance, confidence: 0.96 },
    withoutSummary: { choice: attendance, confidence: 0.96 },
  },
  resultCheck: 0.96,
  incomplete: false,
});
const payment = (
  quote: string,
  amount: string,
  currencyAsSaid = "dollars_unspecified",
  kind = "paid",
) => ({
  kind,
  quotes: [{ label: "agreement", quote, lineIndex: 2 }],
  amount,
  amountRole: "this_payment",
  currencyAsSaid,
  paymentType: "pif",
});
const income = (
  quote: string,
  amountMin: string,
  currencyAsSaid = "dollars_unspecified",
  lineIndex = 2,
) => ({
  kind: "personal_income",
  scenario: "current",
  period: "month",
  amountMin,
  amountMax: amountMin,
  currencyAsSaid,
  quote,
  lineIndex,
  statement: "States monthly personal income",
});
export type SyntheticFixture = {
  name: string;
  transcript: Line[];
  answer: ReturnType<typeof flatAnswer>;
  reading: EarlyReading;
  expected: {
    items: Array<Pick<InsightItem, "kind" | "category"> & Partial<InsightItem>>;
    dropped: Record<string, number>;
    suggestion: null | {
      kind: SuggestionKind;
      tier: SuggestionTier;
      values?: Partial<SuggestionValues>;
    };
    noShowTier: NoShowTier;
    failedChecks?: string[];
  };
};
const emptyDropped = {
  quoteNotFound: 0,
  notProspect: 0,
  amountNotInQuote: 0,
  badCategory: 0,
  cardNumber: 0,
  overLimit: 0,
};
export const SYNTHETIC_FIXTURES: SyntheticFixture[] = [
  {
    name: "paid with bare dollars assumes USD",
    transcript: [
      opening,
      prospect(
        "00:01:00",
        "I pay 1,700 dollars now. My monthly income is 5,000 dollars.",
      ),
    ],
    answer: flatAnswer({
      income: [income("My monthly income is 5,000 dollars.", "5000")],
      result: payment("I pay 1,700 dollars now.", "1700"),
      attendance: { reading: "present" },
    }),
    reading: reading(),
    expected: {
      items: [
        {
          kind: "income",
          category: "personal_income",
          minMinor: 500000,
          currency: "USD",
          currencyAssumed: true,
          band: "b5000",
        },
      ],
      dropped: emptyDropped,
      suggestion: {
        kind: "paid",
        tier: "ready",
        values: { amountMinor: 170000, currency: "USD", currencyAssumed: true },
      },
      noShowTier: "none",
    },
  },
  {
    name: "paid in Canadian dollars",
    transcript: [
      opening,
      prospect(
        "00:01:00",
        "I pay 2,000 Canadian dollars now. My monthly income is 6,000 Canadian dollars.",
      ),
    ],
    answer: flatAnswer({
      income: [
        income("My monthly income is 6,000 Canadian dollars.", "6000", "cad"),
      ],
      result: payment("I pay 2,000 Canadian dollars now.", "2000", "cad"),
      attendance: { reading: "present" },
    }),
    reading: reading(),
    expected: {
      items: [
        {
          kind: "income",
          category: "personal_income",
          minMinor: 600000,
          currency: "CAD",
          band: "other_currency",
        },
      ],
      dropped: emptyDropped,
      suggestion: {
        kind: "paid",
        tier: "ready",
        values: { amountMinor: 200000, currency: "CAD" },
      },
      noShowTier: "none",
    },
  },
  {
    name: "promise to pay Friday",
    transcript: [
      opening,
      prospect("00:01:00", "I will pay 1,700 dollars on Friday, after payday."),
    ],
    answer: flatAnswer({
      result: payment(
        "I will pay 1,700 dollars on Friday, after payday.",
        "1700",
        "dollars_unspecified",
        "promised",
      ),
      attendance: { reading: "present" },
    }),
    reading: reading(),
    expected: {
      items: [],
      dropped: emptyDropped,
      suggestion: {
        kind: "promised",
        tier: "ready",
        values: { amountMinor: 170000 },
      },
      noShowTier: "none",
    },
  },
  {
    name: "later payment correction blocks the wrong model amount",
    transcript: [
      opening,
      prospect("00:01:00", "I pay 3,500 dollars now."),
      prospect("00:02:00", "Sorry, the payment is 2,500 not 3,500."),
    ],
    answer: flatAnswer({
      result: payment("I pay 3,500 dollars now.", "3500"),
      attendance: { reading: "present" },
    }),
    reading: reading(),
    expected: {
      items: [],
      dropped: emptyDropped,
      suggestion: { kind: "paid", tier: "unconfirmed", values: {} },
      noShowTier: "none",
      failedChecks: ["later_amount"],
    },
  },
  {
    name: "call back Thursday at three",
    transcript: [
      opening,
      prospect("00:01:00", "Please call me Thursday November 12 at 3 pm."),
    ],
    answer: flatAnswer({
      result: {
        kind: "call_back",
        quotes: [
          {
            label: "callback",
            quote: "Please call me Thursday November 12 at 3 pm.",
            lineIndex: 2,
          },
        ],
        callbackDateTimeLocal: "2026-11-12T15:00:00",
        contactMethod: "call",
      },
      attendance: { reading: "present" },
    }),
    reading: reading("call_back"),
    expected: {
      items: [],
      dropped: emptyDropped,
      suggestion: {
        kind: "call_back",
        tier: "ready",
        values: {
          callbackAt: Date.parse("2026-11-12T21:00:00Z"),
          contactMethod: "call",
        },
      },
      noShowTier: "none",
    },
  },
  {
    name: "lost on price",
    transcript: [
      opening,
      prospect(
        "00:01:00",
        "That price is beyond my budget, so I will not buy.",
      ),
    ],
    answer: flatAnswer({
      objections: [
        {
          category: "price",
          statement: "Cannot afford the price",
          quote: "That price is beyond my budget",
          lineIndex: 2,
          resolution: "unresolved",
        },
      ],
      result: {
        kind: "lost",
        quotes: [{ label: "decline", quote: "I will not buy.", lineIndex: 2 }],
        lossCategory: "price",
      },
      attendance: { reading: "present" },
    }),
    reading: reading("lost"),
    expected: {
      items: [
        { kind: "objection", category: "price", resolution: "unresolved" },
      ],
      dropped: emptyDropped,
      suggestion: {
        kind: "lost",
        tier: "ready",
        values: { lossCategory: "price" },
      },
      noShowTier: "none",
    },
  },
  {
    name: "Spanish income without a named currency",
    transcript: [
      opening,
      prospect("00:01:00", "Gano cinco mil al mes con mi negocio."),
    ],
    answer: flatAnswer({
      income: [income("Gano cinco mil al mes", "5000", "none")],
      attendance: { reading: "present" },
    }),
    reading: reading("none"),
    expected: {
      items: [
        {
          kind: "income",
          category: "personal_income",
          minMinor: 500000,
          monthlyMinMinor: 500000,
          band: "currency_not_stated",
        },
      ],
      dropped: emptyDropped,
      suggestion: null,
      noShowTier: "none",
    },
  },
  {
    name: "invented income amount is dropped",
    transcript: [
      opening,
      prospect(
        "00:01:00",
        "My business is new and I have no idea what it earns.",
      ),
    ],
    answer: flatAnswer({
      income: [income("My business is new", "9000")],
      attendance: { reading: "present" },
    }),
    reading: reading("none"),
    expected: {
      items: [],
      dropped: { ...emptyDropped, amountNotInQuote: 1 },
      suggestion: null,
      noShowTier: "none",
    },
  },
  {
    name: "an item quoted from the closer is dropped",
    transcript: [
      opening,
      closer("00:01:00", "Perhaps the price is too high for you."),
      prospect("00:02:00", "I am here to learn about the schedule."),
    ],
    answer: flatAnswer({
      objections: [
        {
          category: "price",
          statement: "Price concern",
          quote: "the price is too high",
          lineIndex: 2,
          resolution: "unresolved",
        },
      ],
      attendance: { reading: "present" },
    }),
    reading: reading("none"),
    expected: {
      items: [],
      dropped: { ...emptyDropped, notProspect: 1 },
      suggestion: null,
      noShowTier: "none",
    },
  },
  {
    name: "no-show with waiting and leaving evidence",
    transcript: [
      closer("00:00:05", "Hello Aster, the appointment starts now."),
      closer("00:05:15", "I am still waiting for Aster to arrive."),
      closer("00:07:00", "Nobody arrived, so I am leaving now."),
    ],
    answer: flatAnswer({
      attendance: {
        reading: "absent",
        waiting: [
          { quote: "I am still waiting for Aster to arrive.", lineIndex: 2 },
        ],
        leaving: [
          { quote: "Nobody arrived, so I am leaving now.", lineIndex: 3 },
        ],
      },
    }),
    reading: reading("none", "no_show"),
    expected: {
      items: [],
      dropped: emptyDropped,
      suggestion: { kind: "no_show", tier: "ready" },
      noShowTier: "certain",
    },
  },
  {
    name: "muted prospect forces a human check",
    transcript: [
      opening,
      closer("00:05:15", "I can see you but can't hear you."),
      closer("00:07:00", "We will have to try another day."),
    ],
    answer: flatAnswer({
      attendance: {
        reading: "absent",
        someoneThere: [
          { quote: "I can see you but can't hear you.", lineIndex: 2 },
        ],
      },
    }),
    reading: reading("none", "no_show"),
    expected: {
      items: [],
      dropped: emptyDropped,
      suggestion: { kind: "no_show", tier: "check", values: {} },
      noShowTier: "check",
    },
  },
  {
    name: "empty recording",
    transcript: [],
    answer: flatAnswer({}),
    reading: { incomplete: true },
    expected: {
      items: [],
      dropped: emptyDropped,
      suggestion: { kind: "empty_recording", tier: "unconfirmed", values: {} },
      noShowTier: "empty",
    },
  },
];
