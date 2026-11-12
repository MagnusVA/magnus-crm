import type { Doc } from "../../_generated/dataModel";
import type { InsightItem, SuggestionValues } from "../validators";
import { lowerBound } from "./stats";

export type ReportKind = "quality" | "suggestions" | "no_show";
export type MetricCase = {
  case: Pick<
    Doc<"callInsightEvalCases">,
    "_id" | "status" | "groupKey" | "createdAt" | "listCommittedAt"
  >;
  labels: Array<
    Pick<
      Doc<"callInsightEvalLabels">,
      | "_id"
      | "source"
      | "itemClass"
      | "itemKey"
      | "category"
      | "resolution"
      | "adminVerdict"
      | "wrongFields"
      | "matchedLabelId"
      | "resultKind"
      | "resultTier"
      | "resultValues"
      | "noShowTier"
    >
  >;
  items?: Pick<InsightItem, "key" | "check">[];
  recordedKind?: string;
  hardCaseHeld?: boolean;
};
export type BarDefinition = {
  key: string;
  kind: ReportKind;
  label: string;
  capability: string;
  floor: number;
  callFloor: number;
  rule: string;
  maxWrong?: number;
  minRight?: number;
  callRate?: number;
  maxCallLoss?: number;
};
/** Fixed samples are the first eligible calls reaching both floors. Later calls never move a passed checkpoint. */
export const BAR_DEFINITIONS: readonly BarDefinition[] = [
  {
    key: "invented_income",
    kind: "quality",
    label: "No invented income items",
    capability: "Income for closers",
    floor: 20,
    callFloor: 10,
    rule: "0 invented income items",
    maxWrong: 0,
  },
  {
    key: "income_right",
    kind: "quality",
    label: "Income kind, period and amount are right",
    capability: "Income for closers",
    floor: 20,
    callFloor: 10,
    rule: "at least 90% of calls entirely right",
    callRate: 0.9,
  },
  {
    key: "objection_precision",
    kind: "quality",
    label: "Extracted objections are right",
    capability: "Objections for closers",
    floor: 40,
    callFloor: 15,
    rule: "at least 90% of calls entirely right",
    callRate: 0.9,
  },
  {
    key: "objection_recall",
    kind: "quality",
    label: "The blind objection list is covered",
    capability: "Objections for closers",
    floor: 30,
    callFloor: 15,
    rule: "at least 80% of calls entirely covered",
    callRate: 0.8,
  },
  {
    key: "resolution_right",
    kind: "quality",
    label: "Resolved objection labels are right",
    capability: "Resolution labels",
    floor: 20,
    callFloor: 10,
    rule: "at least 85% of calls entirely right",
    callRate: 0.85,
  },
  {
    key: "recall_lost_jev",
    kind: "quality",
    label: "Jev loses at most five points of recall",
    capability: "Jev item check",
    floor: 30,
    callFloor: 15,
    rule: "at most 5 percentage points of call recall lost",
    maxCallLoss: 0.05,
  },
  {
    key: "right_result",
    kind: "suggestions",
    label: "Ready suggestions name the right result",
    capability: "Suggestions",
    floor: 60,
    callFloor: 60,
    rule: "at most 3 wrong in 60",
    maxWrong: 3,
  },
  {
    key: "callback_date",
    kind: "suggestions",
    label: "Call-back dates are exactly right",
    capability: "Call-back suggestions",
    floor: 20,
    callFloor: 20,
    rule: "at most 2 wrong in 20",
    maxWrong: 2,
  },
  {
    key: "loss_category",
    kind: "suggestions",
    label: "Loss categories are right",
    capability: "Loss category prefill",
    floor: 20,
    callFloor: 20,
    rule: "at most 3 wrong in 20",
    maxWrong: 3,
  },
  {
    key: "actionable_coverage",
    kind: "suggestions",
    label: "Actionable calls get a ready suggestion",
    capability: "Suggestions",
    floor: 40,
    callFloor: 40,
    rule: "at least 28 ready in 40",
    minRight: 28,
  },
  {
    key: "promise_as_paid",
    kind: "suggestions",
    label: "Promises are never suggested as paid",
    capability: "Payment suggestions",
    floor: 15,
    callFloor: 15,
    rule: "0 promises suggested as paid in 15",
    maxWrong: 0,
  },
  {
    key: "named_currency",
    kind: "suggestions",
    label: "Named currencies are right",
    capability: "Named-currency amounts",
    floor: 15,
    callFloor: 15,
    rule: "0 wrong in 15",
    maxWrong: 0,
  },
  {
    key: "usd_assumed",
    kind: "suggestions",
    label: "The USD assumption is applied correctly",
    capability: "Assumed-USD amounts",
    floor: 15,
    callFloor: 15,
    rule: "0 wrong in 15",
    maxWrong: 0,
  },
  {
    key: "amount_carried",
    kind: "suggestions",
    label: "Ready payments carry an amount",
    capability: "Amount prefill",
    floor: 30,
    callFloor: 30,
    rule: "at least 15 amounts in 30",
    minRight: 15,
  },
  {
    key: "amount_prefill",
    kind: "suggestions",
    label: "Prefilled amounts are right",
    capability: "Amount prefill",
    floor: 30,
    callFloor: 30,
    rule: "0 wrong amounts in 30",
    maxWrong: 0,
  },
  {
    key: "wrong_review",
    kind: "no_show",
    label: "Review no-shows are right",
    capability: "Review no-shows",
    floor: 20,
    callFloor: 20,
    rule: "at most 1 wrong in 20",
    maxWrong: 1,
  },
  {
    key: "no_show_coverage",
    kind: "no_show",
    label: "Recorded no-shows reach Certain or Review",
    capability: "Review no-shows",
    floor: 20,
    callFloor: 20,
    rule: "at least 12 of 20",
    minRight: 12,
  },
  {
    key: "no_show_check",
    kind: "no_show",
    label: "Proposed no-shows rarely end in Check",
    capability: "Review no-shows",
    floor: 20,
    callFloor: 20,
    rule: "at most 2 Check in 20",
    maxWrong: 2,
  },
  {
    key: "hard_held_certain",
    kind: "no_show",
    label: "Hard held calls never reach Certain",
    capability: "Certain no-shows",
    floor: 20,
    callFloor: 20,
    rule: "0 Certain in 20 held hard cases",
    maxWrong: 0,
  },
  {
    key: "wrong_certain",
    kind: "no_show",
    label: "Certain no-shows are right",
    capability: "Certain no-shows",
    floor: 100,
    callFloor: 100,
    rule: "0 wrong in 100",
    maxWrong: 0,
  },
];
export const barDefinitions = BAR_DEFINITIONS;
export type Bar = {
  key: string;
  n: number;
  wrong: number;
  calls: number;
  floor: number;
  rule: string;
  lowerBound?: number;
  result: "pass" | "fail" | "inconclusive";
};
type Label = MetricCase["labels"][number];
type Unit = { wrong: boolean; blocks?: boolean; lost?: boolean };
const own = (c: MetricCase, cls: string) =>
  c.labels.find((l) => l.source === "admin" && l.itemClass === cls);
const extracted = (c: MetricCase, cls: string) =>
  c.labels.filter((l) => l.source === "extractor" && l.itemClass === cls);
const result = (c: MetricCase) => extracted(c, "result")[0];
function fieldRight(label: Label | undefined, field?: string) {
  if (!label || !label.adminVerdict || label.adminVerdict === "unsure")
    return false;
  if (label.adminVerdict === "right") return true;
  if (!field || !label.wrongFields?.length) return false;
  return !label.wrongFields.some((f) =>
    [field, "exists", "kind", "resultKind"].includes(f),
  );
}
/**
 * Whether the admin's grade of a suggestion leaves these fields right: graded
 * Right, or Wrong with none of them ticked. Wrong with nothing ticked means
 * the whole item, so every field is wrong. Unsure or ungraded counts wrong.
 * Reads the grade only, never the admin's own typed result.
 */
function gradedRight(label: Label | undefined, fields: readonly string[]) {
  if (!label || !label.adminVerdict || label.adminVerdict === "unsure")
    return false;
  if (label.adminVerdict === "right") return true;
  if (!label.wrongFields?.length) return false;
  return !label.wrongFields.some((f) => [...fields, "exists"].includes(f));
}
function valueRight(
  label: Label | undefined,
  admin: Label | undefined,
  key: keyof SuggestionValues,
) {
  return (
    fieldRight(label, key) &&
    (!admin || label?.resultValues?.[key] === admin.resultValues?.[key])
  );
}
function units(c: MetricCase, key: string): Unit[] {
  const s = result(c),
    a = own(c, "result"),
    attendance = extracted(c, "attendance")[0];
  const noShow = attendance?.noShowTier ?? s?.noShowTier ?? "none";
  const held = own(c, "attendance")?.category === "held";
  const payment = s?.resultKind === "paid" || s?.resultKind === "promised";
  const one = (eligible: boolean, right: boolean): Unit[] =>
    eligible ? [{ wrong: !right }] : [];
  const rightResult =
    fieldRight(s, "resultKind") && (!a || s?.resultKind === a.resultKind);
  const attendanceRight = own(c, "attendance") ? !held : fieldRight(attendance);
  switch (key) {
    case "invented_income":
      return extracted(c, "income").map((l) => ({
        wrong:
          l.adminVerdict === "wrong" &&
          (!l.wrongFields?.length || l.wrongFields.includes("exists")),
        blocks: l.adminVerdict !== "right" && l.adminVerdict !== "wrong",
      }));
    case "income_right":
      return extracted(c, "income").map((l) => ({ wrong: !fieldRight(l) }));
    case "objection_precision":
      return extracted(c, "objection")
        .filter(
          (l) =>
            !c.items?.some(
              (i) => i.key === l.itemKey && i.check === "rejected",
            ),
        )
        .map((l) => ({ wrong: !fieldRight(l) }));
    case "resolution_right":
      return extracted(c, "objection")
        .filter(
          (l) =>
            l.resolution === "resolved" &&
            !c.items?.some(
              (i) => i.key === l.itemKey && i.check === "rejected",
            ),
        )
        .map((l) => ({ wrong: !fieldRight(l, "resolution") }));
    case "objection_recall":
    case "recall_lost_jev": {
      if (
        !c.case.listCommittedAt ||
        !c.labels.some((l) => l.source === "admin")
      )
        return [];
      const admin = c.labels.filter(
        (l) => l.source === "admin" && l.itemClass === "objection",
      );
      const before = admin.every((l) =>
        c.labels.some(
          (e) =>
            e.source === "extractor" &&
            e.itemClass === "objection" &&
            e._id === l.matchedLabelId,
        ),
      );
      return admin.map((l) => {
        const match = c.labels.find(
          (e) =>
            e.source === "extractor" &&
            e._id === l.matchedLabelId &&
            e.itemClass === "objection",
        );
        const rejected =
          !!match &&
          !!c.items?.some(
            (i) => i.key === match.itemKey && i.check === "rejected",
          );
        return {
          wrong: key === "recall_lost_jev" ? rejected : !match || rejected,
          lost: before && rejected,
        };
      });
    }
    case "right_result":
      return one(s?.resultTier === "ready", rightResult);
    case "callback_date":
      return one(s?.resultKind === "call_back", valueRight(s, a, "callbackAt"));
    case "loss_category":
      return one(s?.resultKind === "lost", valueRight(s, a, "lossCategory"));
    case "actionable_coverage":
      return one(
        !!a &&
          ["paid", "promised", "call_back", "lost"].includes(
            a.resultKind ?? "",
          ),
        s?.resultTier === "ready",
      );
    case "promise_as_paid": {
      // The truth is the suggestion's kind when the admin graded it right,
      // and the admin's typed kind only when the grade says the kind is wrong.
      const kindRight = gradedRight(s, ["resultKind"]);
      const promise = kindRight
        ? s?.resultKind === "promised"
        : a?.resultKind === "promised";
      return one(promise, s?.resultKind !== "paid");
    }
    case "named_currency":
      return one(
        payment &&
          !!s?.resultValues?.currency &&
          s.resultValues.currencyAssumed !== true,
        gradedRight(s, ["currency", "currencyAssumed"]),
      );
    case "usd_assumed":
      return one(
        payment && s?.resultValues?.currencyAssumed === true,
        s?.resultValues?.currency === "USD" &&
          gradedRight(s, ["currency", "currencyAssumed"]),
      );
    case "amount_carried":
      return one(
        payment && s?.resultTier === "ready",
        s?.resultValues?.amountMinor !== undefined,
      );
    case "amount_prefill":
      return one(
        payment && s?.resultValues?.amountMinor !== undefined,
        gradedRight(s, ["amountMinor"]),
      );
    case "wrong_review":
      return one(noShow === "review", attendanceRight);
    case "no_show_coverage":
      return one(
        c.recordedKind === "no_show",
        noShow === "certain" || noShow === "review",
      );
    case "no_show_check":
      return one(
        ["certain", "review", "check", "unconfirmed"].includes(noShow),
        noShow !== "check",
      );
    case "hard_held_certain":
      return one(held && c.hardCaseHeld === true, noShow !== "certain");
    case "wrong_certain":
      return one(noShow === "certain", attendanceRight);
    default:
      return [];
  }
}
export function computeMetrics(input: MetricCase[], kind?: ReportKind): Bar[] {
  const people = new Set<string>();
  const cases = input
    .filter(
      (c) => c.case.status === "labels_committed" || c.case.status === "closed",
    )
    .sort(
      (a, b) =>
        a.case.createdAt - b.case.createdAt ||
        String(a.case._id).localeCompare(String(b.case._id)),
    )
    .filter((c) => {
      if (people.has(c.case.groupKey)) return false;
      people.add(c.case.groupKey);
      return true;
    });
  return BAR_DEFINITIONS.filter((d) => !kind || d.kind === kind).map((d) => {
    let n = 0,
      wrong = 0,
      calls = 0,
      failedCalls = 0,
      lostCalls = 0,
      blocks = false;
    for (const c of cases) {
      const eligible = units(c, d.key);
      if (!eligible.length) continue;
      n += eligible.length;
      wrong += eligible.filter((u) => u.wrong).length;
      calls++;
      if (eligible.some((u) => u.wrong)) failedCalls++;
      if (eligible.some((u) => u.lost)) lostCalls++;
      blocks ||= eligible.some((u) => u.blocks);
      if (n >= d.floor && calls >= d.callFloor) break;
    }
    const enough = n >= d.floor && calls >= d.callFloor;
    const passed =
      !blocks &&
      (d.callRate !== undefined
        ? (calls - failedCalls) / calls >= d.callRate
        : d.maxCallLoss !== undefined
          ? lostCalls / calls <= d.maxCallLoss
          : d.minRight !== undefined
            ? n - wrong >= d.minRight
            : wrong <= d.maxWrong!);
    return {
      key: d.key,
      n,
      wrong,
      calls,
      floor: d.floor,
      rule: d.rule,
      ...(calls ? { lowerBound: lowerBound(calls - failedCalls, calls) } : {}),
      result: enough
        ? passed
          ? ("pass" as const)
          : ("fail" as const)
        : ("inconclusive" as const),
    };
  });
}
export const computeBars = computeMetrics;
