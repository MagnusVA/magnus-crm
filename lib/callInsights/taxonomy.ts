/**
 * The fixed categories Call insights sorts a prospect's words into, shared by
 * the Convex module and the UI. Changing a key changes what reports count, so
 * a change here needs a new `TAXONOMY_VERSION`.
 */
export const TAXONOMY_VERSION = "v1";

export const OBJECTION_CATEGORIES = {
  partner: {
    label: "Partner",
    definition: "A spouse or business partner must agree before buying.",
  },
  price: {
    label: "Price",
    definition: "They can't afford the amount or the deposit.",
  },
  financing: {
    label: "Financing",
    definition: "They need a payment plan or an approval.",
  },
  value: {
    label: "Value",
    definition: "They can afford it but don't think it is worth it.",
  },
  timing: {
    label: "Timing",
    definition: "Not now: a season, cash flow or a date is in the way.",
  },
  capacity: {
    label: "Capacity",
    definition: "They have no time or energy to do the work.",
  },
  fit: { label: "Fit", definition: "The program doesn't match their stage." },
  trust: {
    label: "Trust",
    definition: "They doubt the results, the program or the closer.",
  },
  self_efficacy: {
    label: "Self-belief",
    definition: "They doubt they can follow through.",
  },
  alternatives: {
    label: "Alternatives",
    definition: "Another coach, or doing it alone.",
  },
  deliberation: {
    label: "Deliberation",
    definition: "They need to think about it and give no reason.",
  },
  other: {
    label: "Other",
    definition: "A stated objection outside the other categories.",
  },
} as const;

export const STRUGGLE_CATEGORIES = {
  lead_generation: {
    label: "Lead generation",
    definition: "Too few good prospects.",
  },
  sales_conversion: {
    label: "Sales conversion",
    definition: "Consults don't turn into clients.",
  },
  offer_positioning_pricing: {
    label: "Offer & pricing",
    definition: "An unclear offer or prices that are too low.",
  },
  delivery_retention: {
    label: "Delivery & retention",
    definition: "Clients don't stay or don't get results.",
  },
  cashflow_profitability: {
    label: "Cash flow",
    definition: "Busy but little money left over.",
  },
  time_workload: {
    label: "Time & workload",
    definition: "Too many hours doing the work themselves.",
  },
  systems_team: {
    label: "Systems & team",
    definition: "Everything depends on them.",
  },
  knowledge_direction: {
    label: "Direction",
    definition: "They don't know what to do next.",
  },
  execution_confidence: {
    label: "Confidence",
    definition: "They know what to do and don't do it.",
  },
  personal_wellbeing: {
    label: "Wellbeing",
    definition: "Health, energy or stress.",
  },
  other: {
    label: "Other",
    definition: "A stated struggle outside the other categories.",
  },
} as const;

export const GOAL_CATEGORIES = {
  revenue_growth: {
    label: "Revenue growth",
    definition: "Grow gross sales, often to a number.",
  },
  profit_personal_income: {
    label: "Take home more",
    definition: "Earn more personally from the business.",
  },
  predictable_clients: {
    label: "Predictable clients",
    definition: "A steady flow of clients.",
  },
  sales_capability: {
    label: "Sales capability",
    definition: "Close consults with confidence.",
  },
  launch_offer: {
    label: "Launch offer",
    definition: "Start online or launch a new offer.",
  },
  scale_systems_team: {
    label: "Scale systems & team",
    definition: "Hire, delegate or systemize.",
  },
  time_lifestyle_freedom: {
    label: "Time & lifestyle freedom",
    definition: "Fewer hours, more family time.",
  },
  career_transition: {
    label: "Career transition",
    definition: "Leave the gym or a job.",
  },
  personal_wellbeing: { label: "Wellbeing", definition: "Health or energy." },
  mastery_confidence: {
    label: "Mastery & confidence",
    definition: "Feel like a real business owner.",
  },
  other: {
    label: "Other",
    definition: "A stated goal outside the other categories.",
  },
} as const;

export const INCOME_KINDS = {
  personal_income: { label: "Personal income" },
  business_revenue: { label: "Business revenue" },
  business_profit: { label: "Business profit" },
  savings: { label: "Savings" },
  budget: { label: "Budget" },
} as const;

export const INCOME_SCENARIOS = ["current", "target"] as const;
export const INCOME_PERIODS = [
  "week",
  "month",
  "year",
  "hour",
  "per_session",
  "one_off",
  "point_in_time",
  "unknown",
] as const;
export const RESOLUTIONS = ["resolved", "unresolved", "unknown"] as const;

export type ObjectionCategory = keyof typeof OBJECTION_CATEGORIES;
export type StruggleCategory = keyof typeof STRUGGLE_CATEGORIES;
export type GoalCategory = keyof typeof GOAL_CATEGORIES;
export type IncomeKind = keyof typeof INCOME_KINDS;
export type IncomeScenario = (typeof INCOME_SCENARIOS)[number];
export type IncomePeriod = (typeof INCOME_PERIODS)[number];
export type Resolution = (typeof RESOLUTIONS)[number];

export const ITEM_KINDS = ["objection", "struggle", "goal", "income"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

const CATEGORY_TABLES = {
  objection: OBJECTION_CATEGORIES,
  struggle: STRUGGLE_CATEGORIES,
  goal: GOAL_CATEGORIES,
  income: INCOME_KINDS,
} as const;

export function categoryKeys(kind: ItemKind): string[] {
  return Object.keys(CATEGORY_TABLES[kind]);
}

export function isCategory(kind: ItemKind, category: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATEGORY_TABLES[kind], category);
}

/** The label a card or report shows for a category key. Unknown keys read as the key. */
export function categoryLabel(kind: ItemKind, category: string): string {
  const table: Record<string, { label: string }> = CATEGORY_TABLES[kind];
  return table[category]?.label ?? category;
}

/**
 * Monthly income bands in USD major units, as lower edges. A range that
 * crosses an edge reads "Spans bands"; only USD gets a band.
 */
export const INCOME_BAND_EDGES: Partial<Record<IncomeKind, number[]>> = {
  personal_income: [0, 1, 1_000, 3_000, 5_000, 10_000, 20_000],
  business_revenue: [0, 1, 5_000, 10_000, 25_000, 50_000, 100_000],
  savings: [0, 1_000, 3_000, 5_000, 10_000, 25_000],
  budget: [0, 1_000, 3_000, 5_000, 10_000, 25_000],
};

/** Band keys that aren't a money range. */
export const INCOME_BAND_SPECIAL = [
  "spans_bands",
  "currency_not_stated",
  "other_currency",
  "no_monthly_equivalent",
  "speaker_unclear",
] as const;

/** What a person can pick for a no-show (the existing form's reasons). */
export const NO_SHOW_REASONS = [
  "no_response",
  "late_cancel",
  "technical_issues",
  "other",
] as const;
export type NoShowReason = (typeof NO_SHOW_REASONS)[number];

/** The fixed loss labels a suggestion may put in the Lost form's reason. */
export const LOSS_CATEGORIES = {
  not_a_fit: "Not a fit",
  price: "Price or payment terms",
  timing: "Timing",
  went_quiet: "Went quiet",
  other: "Other",
} as const;
export type LossCategory = keyof typeof LOSS_CATEGORIES;

export const SUGGESTION_KINDS = [
  "paid",
  "promised",
  "call_back",
  "lost",
  "no_show",
  "no_decision",
  "empty_recording",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_TIERS = ["ready", "check", "unconfirmed"] as const;
export type SuggestionTier = (typeof SUGGESTION_TIERS)[number];

export const NO_SHOW_TIERS = [
  "none",
  "empty",
  "check",
  "certain",
  "review",
  "unconfirmed",
] as const;
export type NoShowTier = (typeof NO_SHOW_TIERS)[number];

export const SUGGESTION_KIND_LABELS: Record<SuggestionKind, string> = {
  paid: "Paid on the call",
  promised: "Promised to pay",
  call_back: "Call back",
  lost: "Lost",
  no_show: "No-show",
  no_decision: "No decision",
  empty_recording: "Empty recording",
};
