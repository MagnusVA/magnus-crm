import type {
  GoalCategory,
  ObjectionCategory,
  StruggleCategory,
} from "../../lib/callInsights/taxonomy";
import { linesAround, renderLines, type PreparedLine } from "./transcriptPrep";
import type { InsightItem } from "./validators";

export const ITEM_THRESHOLDS = {
  confirm: 0.7,
  reject: 0.25,
  resolved: 0.7,
} as const;

// One fixed statement per category, written from the taxonomy, never from the
// extractor's wording. Each describes the topic the way people talk about it
// ("that's a lot of money"), not the strict definition ("cannot afford it"):
// against the gateway a strict sentence scored 0.29 on a clear price objection.
const OBJECTIONS = {
  partner:
    "In these lines the prospect says they need to talk to, or get agreement from, a spouse or partner before buying.",
  price:
    "In these lines the prospect raises a concern about the price: that it is a lot of money, too expensive, or hard for them to afford.",
  financing:
    "In these lines the prospect says they would need a payment plan, financing or an approval to be able to buy.",
  value:
    "In these lines the prospect questions whether the offer is worth the money.",
  timing:
    "In these lines the prospect says now is not the right time to buy, because of a season, their cash flow or a date.",
  capacity:
    "In these lines the prospect says they may not have the time or energy to do the work.",
  fit: "In these lines the prospect questions whether the program suits their situation or stage.",
  trust:
    "In these lines the prospect expresses doubt about the results, the program or the closer.",
  self_efficacy:
    "In these lines the prospect doubts that they would follow through or succeed with it.",
  alternatives:
    "In these lines the prospect mentions another coach, another program or doing it on their own as an option.",
  deliberation:
    "In these lines the prospect says they need to think about it before deciding.",
  other:
    "In these lines the prospect raises a concern or hesitation about buying.",
} satisfies Record<ObjectionCategory, string>;

const STRUGGLES = {
  lead_generation:
    "In these lines the prospect says they have trouble getting enough clients or leads, or getting them consistently.",
  sales_conversion:
    "In these lines the prospect says they have trouble turning consultations or leads into paying clients.",
  offer_positioning_pricing:
    "In these lines the prospect says their offer is unclear or that they charge too little.",
  delivery_retention:
    "In these lines the prospect says their clients do not stay or do not get results.",
  cashflow_profitability:
    "In these lines the prospect says money is tight in the business or little is left over.",
  time_workload:
    "In these lines the prospect says they work too many hours or are overloaded.",
  systems_team:
    "In these lines the prospect says the business depends on them, or lacks systems or help.",
  knowledge_direction:
    "In these lines the prospect says they do not know what to do next or how to grow.",
  execution_confidence:
    "In these lines the prospect says they know what to do but struggle to do it, or lack confidence.",
  personal_wellbeing:
    "In these lines the prospect says they struggle with their health, energy or stress.",
  other:
    "In these lines the prospect describes a problem they have in their business or work.",
} satisfies Record<StruggleCategory, string>;

const GOALS = {
  revenue_growth:
    "In these lines the prospect says they want the business to make more money or reach a revenue number.",
  profit_personal_income:
    "In these lines the prospect says they want to take home more money personally.",
  predictable_clients:
    "In these lines the prospect says they want a steady or predictable flow of clients.",
  sales_capability:
    "In these lines the prospect says they want to get better at selling or closing.",
  launch_offer:
    "In these lines the prospect says they want to start something new, such as going online or launching a new offer.",
  scale_systems_team:
    "In these lines the prospect says they want to hire, delegate or build systems.",
  time_lifestyle_freedom:
    "In these lines the prospect says they want to work less or have more free time.",
  career_transition:
    "In these lines the prospect says they want to leave a job or change what they do for work.",
  personal_wellbeing:
    "In these lines the prospect says they want better health or energy.",
  mastery_confidence:
    "In these lines the prospect says they want to feel more capable or confident as a business owner.",
  other:
    "In these lines the prospect says there is something they want to achieve.",
} satisfies Record<GoalCategory, string>;

export function buildItemCheck(
  item: InsightItem,
  lines: PreparedLine[],
): {
  state: string;
  questions: Record<string, { type: "noul"; instructions: string }>;
} {
  const tables: Record<
    "objection" | "struggle" | "goal",
    Record<string, string>
  > = {
    objection: OBJECTIONS,
    struggle: STRUGGLES,
    goal: GOALS,
  };
  const table = item.kind === "income" ? undefined : tables[item.kind];
  const instructions =
    item.kind === "income"
      ? "In these lines the prospect states an amount of money they earn, have or want."
      : table && Object.hasOwn(table, item.category)
        ? table[item.category]
        : undefined;
  if (!instructions) throw new Error("Unsupported item category");
  const questions: Record<string, { type: "noul"; instructions: string }> = {
    present: { type: "noul", instructions },
  };
  const selected = linesAround(lines, item.lineIndex, 3);
  if (
    item.kind === "objection" &&
    item.resolution === "resolved" &&
    item.resolutionLineIndex !== undefined
  ) {
    selected.push(...linesAround(lines, item.resolutionLineIndex, 3));
    questions.resolved = {
      type: "noul",
      instructions:
        "In these lines the prospect accepts or lets go of the concern raised earlier.",
    };
  }
  const ordered = [
    ...new Map(selected.map((line) => [line.index, line])).values(),
  ].sort((a, b) => a.index - b.index);
  return { state: renderLines(ordered), questions };
}

export function applyItemCheck(
  item: InsightItem,
  answers: Record<string, { noul?: number }> | undefined,
): InsightItem {
  const checked = { ...item };
  delete checked.score;
  delete checked.resolutionScore;
  const valid = (n: number | undefined): n is number =>
    n !== undefined && Number.isFinite(n) && n >= 0 && n <= 1;
  const score = answers?.present?.noul;
  checked.check = "unsure";
  if (valid(score)) {
    checked.score = score;
    if (score >= ITEM_THRESHOLDS.confirm) checked.check = "confirmed";
    else if (score <= ITEM_THRESHOLDS.reject) checked.check = "rejected";
  }
  if (item.kind === "objection" && item.resolution === "resolved") {
    const resolutionScore = answers?.resolved?.noul;
    if (valid(resolutionScore)) checked.resolutionScore = resolutionScore;
    if (!valid(resolutionScore) || resolutionScore < ITEM_THRESHOLDS.resolved)
      checked.resolution = "unknown";
  }
  return checked;
}
